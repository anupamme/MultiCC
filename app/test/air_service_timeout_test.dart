import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SettingsService settings;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    settings = await SettingsService.getInstance();
  });

  for (final batch in [false, true]) {
    final label = batch ? '批量清理' : '单任务删除';

    test('$label 超过 30 秒后仍等待并接收 49 秒时的成功结果', () {
      fakeAsync((clock) {
        final response = Completer<http.Response>();
        final requests = <http.Request>[];
        final service = AirService(
          settings: settings,
          httpClient: MockClient((request) {
            requests.add(request);
            return response.future;
          }),
        );
        var completed = false;
        Object? error;
        final future = batch
            ? service.deleteTaskRetention('d1', ['t1'])
            : service.deleteTask('t1');
        future.then<void>(
          (_) {
            completed = true;
          },
          onError: (Object e) {
            error = e;
          },
        );
        clock.flushMicrotasks();
        clock.elapse(const Duration(seconds: 31));
        expect(completed, isFalse);
        expect(error, isNull);

        clock.elapse(const Duration(seconds: 18));
        response.complete(http.Response('{"ok":true}', 200));
        clock.flushMicrotasks();
        expect(completed, isTrue);
        expect(error, isNull);
        expect(requests, hasLength(1));
        expect(requests.single.method, batch ? 'POST' : 'DELETE');
        expect(
          requests.single.body,
          batch
              ? jsonEncode({
                  'taskIds': ['t1'],
                })
              : isEmpty,
        );
      });
    });

    test('$label 等待 2 分钟后提示结果待确认，不自动重试或强制删除', () {
      fakeAsync((clock) {
        final response = Completer<http.Response>();
        var requestCount = 0;
        final service = AirService(
          settings: settings,
          httpClient: MockClient((_) {
            requestCount += 1;
            return response.future;
          }),
        );
        var completed = false;
        Object? error;
        final future = batch
            ? service.deleteTaskRetention('d1', ['t1'])
            : service.deleteTask('t1');
        future.then<void>(
          (_) {
            completed = true;
          },
          onError: (Object e) {
            error = e;
          },
        );
        clock.flushMicrotasks();
        clock.elapse(const Duration(seconds: 119));
        expect(completed, isFalse);
        expect(error, isNull);
        clock.elapse(const Duration(seconds: 1));
        expect(error, isA<AirTaskActionException>());
        expect((error as AirTaskActionException).code, 'task_delete_timeout');
        expect(error.toString(), contains('结果尚未确认'));
        expect(error.toString(), contains('稍后刷新'));
        expect(completed, isFalse);
        expect(requestCount, 1);

        // 服务端后来成功也不会把已经交给界面的超时误报为已删除。
        response.complete(http.Response('{"ok":true}', 200));
        clock.flushMicrotasks();
        expect(completed, isFalse);
        expect(requestCount, 1);
      });
    });
  }

  for (final lifecycle in [false, true]) {
    test(lifecycle ? '普通生命周期写仍在 30 秒超时' : '清理预览仍在 30 秒超时', () {
      fakeAsync((clock) {
        final response = Completer<http.Response>();
        final service = AirService(
          settings: settings,
          httpClient: MockClient((_) => response.future),
        );
        Object? error;
        final future = lifecycle
            ? service.setTaskLifecycle('t1', 'archived')
            : service.previewTaskRetention('d1');
        future.then<void>(
          (_) {},
          onError: (Object e) {
            error = e;
          },
        );
        clock.flushMicrotasks();
        clock.elapse(const Duration(seconds: 29));
        expect(error, isNull);
        clock.elapse(const Duration(seconds: 1));
        expect(error, isA<TimeoutException>());
        response.complete(http.Response('{"ok":true}', 200));
        clock.flushMicrotasks();
      });
    });
  }

  test('生命周期保留服务端可读原因，错误码和保护原因不变', () async {
    const message = '该任务的历史仍被其他任务引用，暂时无法删除。';
    final service = AirService(
      settings: settings,
      httpClient: MockClient(
        (_) async => http.Response(
          jsonEncode({
            'ok': false,
            'code': 'TASK_HISTORY_REFERENCED',
            'message': message,
            'reasons': ['history_referenced'],
          }),
          409,
          headers: {'content-type': 'application/json; charset=utf-8'},
        ),
      ),
    );
    await expectLater(
      service.deleteTask('t1'),
      throwsA(
        isA<AirTaskActionException>()
            .having((e) => e.code, '错误码', 'TASK_HISTORY_REFERENCED')
            .having((e) => e.reasons, '保护原因', ['history_referenced'])
            .having((e) => e.toString(), '可读原因', contains(message)),
      ),
    );
  });
}
