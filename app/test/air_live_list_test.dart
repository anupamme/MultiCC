import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/air_sync_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_mobile_workspace.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUpAll(() => I18n.init('zh'));
  testWidgets(
    'background updates retain page, scroll, search and in-flight long press',
    (tester) async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://localhost:3000',
      });
      final settings = await SettingsService.getInstance();
      var revision = 1;
      Completer<void>? pageGate;
      final tasks = [
        for (var i = 0; i < 100; i++)
          {
            'id': 't$i',
            'dirId': 'd',
            'title': 'Task $i',
            'status': 'active',
            'runState': 'idle',
            'updatedAt': i,
          },
      ];
      final client = MockClient((req) async {
        Object body = <String, dynamic>{};
        if (req.url.path == '/api/air/sync') {
          if (req.url.queryParameters.containsKey('cursor')) {
            tasks.first['title'] = 'Updated Task 0';
          }
          body = req.url.queryParameters.containsKey('cursor')
              ? {
                  'cursor': 'boot:$revision',
                  'events': [
                    {
                      'cursor': 'boot:$revision',
                      'previous': 'boot:${revision - 1}',
                      'tasks': [
                        {...tasks.first, 'title': 'Updated Task 0'},
                      ],
                    },
                  ],
                }
              : {
                  'cursor': 'boot:$revision',
                  'tasks': tasks.take(2).toList(),
                  'directories': [
                    {'id': 'd', 'name': 'Project', 'path': '/project'},
                  ],
                };
        } else if (req.url.path == '/api/air/page') {
          final page = int.parse(req.url.queryParameters['page'] ?? '1');
          final limit = int.parse(req.url.queryParameters['limit'] ?? '20');
          await pageGate?.future;
          body = {
            'cursor': 'boot:$revision',
            'page': page,
            'pages': (tasks.length / limit).ceil(),
            'total': tasks.length,
            'tasks': tasks.skip((page - 1) * limit).take(limit).toList(),
          };
        } else if (req.url.path == '/api/auth/ws-ticket') {
          return http.Response('{}', 503);
        }
        return http.Response(
          jsonEncode(body),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      final service = AirService(settings: settings, httpClient: client);
      final sync = AirSyncService(service, random: () => 0);
      addTearDown(() {
        pageGate?.complete();
        sync.dispose();
        service.close();
      });
      await sync.refresh();
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var actions = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: sync,
              builder: (_, _) => AirMobileWorkspace(
                data: sync.snapshot,
                sync: sync,
                directoryId: null,
                recentTasks: const [],
                onOpenTask: (_) {},
                onTaskAction: (_) => actions++,
                onRefresh: () async {
                  await sync.refresh();
                },
                onResource: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final search = find.byKey(const ValueKey('air-mobile-task-search'));
      await tester.enterText(search, 'Task');
      await tester.pumpAndSettle();
      final searchElement = tester.element(search);
      final input = tester.widget<EditableText>(
        find.descendant(of: search, matching: find.byType(EditableText)),
      );
      final selection = input.controller.selection;
      expect(input.focusNode.hasFocus, isTrue);
      pageGate = Completer<void>();
      revision++;
      await sync.refresh();
      await tester.pump();
      expect(identical(tester.element(search), searchElement), isTrue);
      expect(input.focusNode.hasFocus, isTrue);
      expect(input.controller.text, 'Task');
      expect(input.controller.selection, selection);
      expect(find.byType(LinearProgressIndicator), findsNothing);
      pageGate.complete();
      pageGate = null;
      await tester.pumpAndSettle();
      final listFinder = find.byKey(
        const PageStorageKey('mobile-console-scroll'),
      );
      // 滚到底自动接第二页（一页 50 条），第二页的行接在第一页后面。
      final row = find.byKey(const ValueKey('air-task-t60'));
      await tester.scrollUntilVisible(
        row,
        400,
        scrollable: find
            .descendant(of: listFinder, matching: find.byType(Scrollable))
            .first,
      );
      await Scrollable.ensureVisible(tester.element(row), alignment: .5);
      await tester.pumpAndSettle();
      final controller = tester.widget<ListView>(listFinder).controller!;
      expect(find.byKey(const ValueKey('air-task-t59')), findsOneWidget);
      await tester.pump();
      final offset = controller.offset;
      expect(offset, greaterThan(0));
      final gesture = await tester.startGesture(tester.getCenter(row));
      pageGate = Completer<void>();
      revision++;
      await sync.refresh();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(LinearProgressIndicator), findsNothing);
      expect(controller.offset, offset);
      expect(
        actions,
        1,
        reason: 'background update must not cancel a long press',
      );
      await gesture.up();
      pageGate.complete();
      pageGate = null;
      await tester.pumpAndSettle();
      expect(controller.offset, offset);
      expect(
        sync.page('mobile-list-2', {
          'dirId': null,
          'status': 'recent',
          'query': 'Task',
          'limit': 50,
          'page': 2,
        })!.page,
        2,
      );
      expect(sync.snapshot!.taskOf('t0')!.title, 'Updated Task 0');
      sync.pause();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
