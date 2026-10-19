import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/air_sync_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _RealHttpOverrides extends HttpOverrides {}

class _Host {
  late HttpServer server;
  final sockets = <WebSocket>[];
  final calls = <Uri>[];
  final tasks = <String, Map<String, dynamic>>{};
  String epoch = 'boot-a';
  int revision = 1, syncStatus = 200, pageStatus = 200;
  Completer<void>? pageGate, ticketGate;
  bool legacy = false;
  String get cursor => '$epoch:$revision';
  _Host() {
    for (var i = 0; i < 1278; i++) {
      tasks['t$i'] = {
        'id': 't$i',
        'title': 'Task $i',
        'dirId': 'd',
        'status': 'active',
        'updatedAt': i,
        'runState': 'idle',
      };
    }
  }
  Map<String, dynamic> get stats => {
    'all': {
      'total': tasks.length,
      'open': tasks.length,
      'running': 1,
      'needs': 11,
    },
    'd': {
      'total': tasks.length,
      'open': tasks.length,
      'running': 1,
      'needs': 11,
    },
  };
  Map<String, dynamic> get metadata => {
    'directories': [
      {'id': 'd', 'name': 'Project', 'path': '/project'},
    ],
    'taskPins': [],
    'taskTodos': ['t0'],
    'taskStats': stats,
  };
  Map<String, dynamic> get delta => {
    'type': 'air_delta',
    'cursor': cursor,
    'previous': '$epoch:${revision - 1}',
    'tasks': [tasks['t0']],
    'deleted': [],
    'taskStats': stats,
  };
  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final uri = request.uri;
      calls.add(uri);
      if (uri.path == '/ws/meta') {
        final ws = await WebSocketTransformer.upgrade(request);
        sockets.add(ws);
        ws.listen((_) {});
        ws.add(jsonEncode({'type': 'air_synced', 'cursor': cursor}));
        return;
      }
      Object body = <String, dynamic>{'ok': true};
      if (uri.path == '/api/auth/ws-ticket') {
        final payload =
            jsonDecode(await utf8.decoder.bind(request).join()) as Map;
        await ticketGate?.future;
        body = {'ticket': 'test-ticket', 'path': payload['path']};
      } else if (uri.path == '/api/air/sync') {
        request.response.statusCode = legacy ? 404 : syncStatus;
        final since = uri.queryParameters['cursor'];
        if (since != null && !since.startsWith('$epoch:')) {
          body = {'ok': true, 'cursor': cursor, 'reset': true};
        } else if (since != null) {
          body = {
            'ok': true,
            'cursor': cursor,
            'taskStats': stats,
            'events': since == cursor
                ? []
                : [
                    {...delta, 'previous': since},
                  ],
          };
        } else {
          body = {
            ...metadata,
            'ok': true,
            'cursor': cursor,
            'tasks': tasks.values.take(2).toList(),
          };
        }
      } else if (uri.path == '/api/air/page') {
        request.response.statusCode = pageStatus;
        final requestedCursor = cursor;
        final page = int.tryParse(uri.queryParameters['page'] ?? '') ?? 1;
        final limit = int.parse(
          uri.queryParameters['limit'] ?? '20',
        ).clamp(1, 50);
        final values = tasks.values
            .skip((page - 1) * limit)
            .take(limit)
            .toList();
        await pageGate?.future;
        body = {
          'ok': true,
          'cursor': requestedCursor,
          'page': page,
          'pages': (tasks.length / limit).ceil(),
          'total': tasks.length,
          'tasks': values,
        };
      } else if (uri.path == '/api/air') {
        body = {...metadata, 'tasks': tasks.values.toList()};
      } else if (uri.path == '/api/external-fleets') {
        body = {'fleets': []};
      }
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(body));
      await request.response.close();
    });
  }

  Future<AirSyncService> client() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:${server.port}',
    });
    final settings = await SettingsService.getInstance();
    await settings.save(host: 'http://127.0.0.1:${server.port}');
    final service = AirService(settings: settings);
    addTearDown(service.close);
    final sync = AirSyncService(service, random: () => 0);
    addTearDown(sync.dispose);
    return sync;
  }

  Future<void> close() async {
    if (pageGate != null && !pageGate!.isCompleted) pageGate!.complete();
    if (ticketGate != null && !ticketGate!.isCompleted) ticketGate!.complete();
    for (final ws in sockets) {
      await ws.close();
    }
    await server.close(force: true);
  }

  void push() {
    for (final ws in sockets.where((s) => s.readyState == WebSocket.open)) {
      ws.add(jsonEncode(delta));
    }
  }
}

Future<void> until(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 4));
  while (!condition() && DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  expect(condition(), isTrue);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = _RealHttpOverrides();
  late _Host host;
  setUp(() async {
    host = _Host();
    await host.start();
  });
  tearDown(() => host.close());

  test(
    '1278 tasks: bootstrap stays partial, page reads coalesce, authenticated WS updates immediately',
    () async {
      final sync = await host.client();
      final snapshot = await sync.refresh();
      expect(snapshot.tasks, hasLength(2));
      expect(snapshot.count('total'), 1278);
      await until(() => host.sockets.isNotEmpty);
      final socketCall = host.calls.firstWhere((u) => u.path == '/ws/meta');
      expect(socketCall.queryParameters['air'], '1');
      expect(socketCall.queryParameters['cursor'], 'boot-a:1');
      expect(socketCall.queryParameters.containsKey('token'), isFalse);
      for (var i = 0; i < 10; i++) {
        sync.page('directory', {'page': 2});
      }
      await until(() => sync.page('directory', {'page': 2}) != null);
      expect(host.calls.where((u) => u.path == '/api/air/page'), hasLength(1));
      expect(sync.page('directory', {'page': 2})!.ids.first, 't20');
      host.tasks['t0'] = {
        ...host.tasks['t0']!,
        'title': 'Changed while connected',
        'runState': 'running',
      };
      host.revision++;
      host.push();
      await until(
        () => sync.snapshot!.taskOf('t0')!.title == 'Changed while connected',
      );
      expect(sync.snapshot!.count('total'), 1278);
      expect(host.calls.where((u) => u.path == '/api/air'), isEmpty);
    },
  );

  test(
    'live updates retain page rows while revalidating, including failures and manual invalidation',
    () async {
      final sync = await host.client();
      await sync.refresh();
      await until(() => sync.status == 'live');
      await until(() => sync.page('list', {'page': 2}) != null);
      final cached = sync.page('list', {'page': 2})!;
      host.pageGate = Completer<void>();
      host.revision++;
      host.push();
      await until(() => sync.snapshot!.cursor == host.cursor);
      expect(sync.page('list', {'page': 2})?.ids, cached.ids);
      expect(sync.snapshot!.taskOf('t20'), isNotNull);
      // Repeated builds coalesce the background read and retain the same rows.
      for (var i = 0; i < 10; i++) {
        expect(sync.page('list', {'page': 2})?.page, 2);
      }
      await until(
        () => host.calls.where((u) => u.path == '/api/air/page').length == 2,
      );
      host.pageGate!.complete();
      host.pageGate = null;
      await until(() => !identical(sync.page('list', {'page': 2}), cached));
      host.pageStatus = 503;
      sync.invalidate();
      expect(sync.page('list', {'page': 2})?.ids, cached.ids);
      await until(
        () => host.calls.where((u) => u.path == '/api/air/page').length == 3,
      );
      await Future<void>.delayed(const Duration(milliseconds: 50));
      final calls = host.calls.length;
      expect(sync.page('list', {'page': 2})?.ids, cached.ids);
      expect(
        host.calls.length,
        calls,
        reason: 'failed reads retain rows and back off',
      );
      // A different query must never show rows from the old query.
      expect(sync.page('list', {'page': 3}), isNull);
    },
  );

  test(
    'same-epoch bootstrap retains loaded rows until their pages are revalidated',
    () async {
      final sync = await host.client();
      await sync.refresh();
      await until(() => sync.page('list', {'page': 2}) != null);
      final ids = sync.page('list', {'page': 2})!.ids;
      await sync.refresh(fresh: true);
      expect(sync.page('list', {'page': 2})?.ids, ids);
      expect(sync.snapshot!.taskOf('t20'), isNotNull);
      sync.pause();
      host.epoch = 'boot-b';
      await sync.resume();
      expect(sync.page('list', {'page': 2}), isNull);
      expect(sync.snapshot!.taskOf('t20'), isNull);
    },
  );

  test(
    'duplicate deltas preserve page cache; a cursor gap catches up over HTTP',
    () async {
      final sync = await host.client();
      await sync.refresh();
      await until(() => sync.status == 'live');
      await until(() => sync.page('directory', {'page': 2}) != null);
      final cached = sync.page('directory', {'page': 2});
      var notifications = 0;
      sync.addListener(() => notifications++);
      host.push();
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(notifications, 0);
      expect(identical(sync.page('directory', {'page': 2}), cached), isTrue);
      host.revision = 3;
      host.tasks['t0'] = {...host.tasks['t0']!, 'title': 'Recovered gap'};
      host.push();
      await until(() => sync.snapshot!.cursor == 'boot-a:3');
      expect(sync.snapshot!.taskOf('t0')!.title, 'Recovered gap');
      expect(
        host.calls
            .where((u) => u.path == '/api/air/sync')
            .last
            .queryParameters['cursor'],
        'boot-a:1',
      );
      expect(host.calls.where((u) => u.path == '/api/air'), isEmpty);
    },
  );

  test(
    'background/resume catches up by cursor; server restart rebuilds the epoch',
    () async {
      final sync = await host.client();
      await sync.refresh();
      await until(() => host.sockets.isNotEmpty);
      sync.pause();
      host.revision += 3;
      host.tasks['t0'] = {...host.tasks['t0']!, 'title': 'Offline change'};
      await sync.resume();
      expect(sync.snapshot!.taskOf('t0')!.title, 'Offline change');
      expect(sync.snapshot!.cursor, 'boot-a:4');
      expect(
        host.calls
            .where((u) => u.path == '/api/air/sync')
            .last
            .queryParameters['cursor'],
        'boot-a:1',
      );
      sync.pause();
      host.epoch = 'boot-b';
      host.revision = 1;
      host.tasks.remove('t0');
      await sync.resume();
      expect(sync.snapshot!.cursor, 'boot-b:1');
      expect(sync.snapshot!.taskOf('t0'), isNull);
      expect(host.calls.where((u) => u.path == '/api/air'), isEmpty);
    },
  );

  test(
    'late page and late ticket cannot repopulate a paused/new view',
    () async {
      host.ticketGate = Completer<void>();
      final sync = await host.client();
      await sync.refresh();
      host.pageGate = Completer<void>();
      sync.page('list', {'page': 2});
      await until(() => host.calls.any((u) => u.path == '/api/air/page'));
      sync.pause();
      host.pageGate!.complete();
      host.pageGate = null;
      host.ticketGate!.complete();
      host.ticketGate = null;
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(host.sockets, isEmpty);
      expect(sync.snapshot!.taskOf('t20'), isNull);
      await sync.resume();
      sync.page('list', {'page': 3});
      await until(() => sync.page('list', {'page': 3}) != null);
      expect(sync.page('list', {'page': 3})!.ids.first, 't40');
      expect(sync.snapshot!.taskOf('t20'), isNull);
    },
  );

  test(
    'returning to a cached query supersedes the pending different page',
    () async {
      final sync = await host.client();
      await sync.refresh();
      await until(() => sync.page('list', {'page': 1}) != null);
      final cached = sync.page('list', {'page': 1});
      host.pageGate = Completer<void>();
      sync.page('list', {'page': 2});
      await until(
        () => host.calls.where((u) => u.path == '/api/air/page').length == 2,
      );
      expect(identical(sync.page('list', {'page': 1}), cached), isTrue);
      host.pageGate!.complete();
      host.pageGate = null;
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(identical(sync.page('list', {'page': 1}), cached), isTrue);
      expect(sync.snapshot!.taskOf('t20'), isNull);
      expect(host.calls.where((u) => u.path == '/api/air/page'), hasLength(2));
    },
  );

  test('page cache and task pool remain bounded across 30 views', () async {
    final sync = await host.client();
    await sync.refresh();
    for (var page = 1; page <= 30; page++) {
      sync.page('slot$page', {'page': page});
      await until(() => sync.page('slot$page', {'page': page}) != null);
    }
    expect(sync.snapshot!.tasks.length, lessThanOrEqualTo(350));
    expect(sync.snapshot!.count('total'), 1278);
  });

  test(
    'only unsupported endpoints use legacy; temporary/auth failures never download full snapshot',
    () async {
      host.legacy = true;
      final legacy = await host.client();
      await legacy.refresh();
      await legacy.refresh(fresh: true);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(legacy.indexed, isFalse);
      expect(host.calls.where((u) => u.path == '/api/air/sync'), hasLength(1));
      expect(host.calls.where((u) => u.path == '/api/air'), hasLength(2));
      host.calls.clear();
      host.legacy = false;
      host.syncStatus = 503;
      final warming = await host.client();
      await expectLater(warming.refresh(), throwsException);
      expect(host.calls.where((u) => u.path == '/api/air'), isEmpty);
      host.syncStatus = 403;
      await expectLater(warming.refresh(), throwsException);
      expect(host.calls.where((u) => u.path == '/api/air'), isEmpty);
    },
  );
}
