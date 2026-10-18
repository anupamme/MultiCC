import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/task_directory_hint_prompt.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SettingsService settings;
  setUpAll(() async {
    await I18n.init('zh');
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
    await settings.save(host: 'http://localhost:3000', token: 'test-token');
  });

  testWidgets('shows the directory name and keeps the card on task_busy', (
    tester,
  ) async {
    final events = StreamController<ChatEvent>.broadcast();
    var dismissed = false;
    http.Response json(Object body, [int status = 200]) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: {'Content-Type': 'application/json; charset=utf-8'},
    );
    final client = MockClient((request) async {
      expect(request.headers['X-Access-Token'], 'test-token');
      final path = request.url.path;
      if (path == '/api/task-shells/shell1/attribution-decisions') {
        return json({
          'ok': true,
          'decisions': [
            {
              'id': 'dec_1',
              'fromTaskId': 'tsk_from',
              'toTaskId': null,
              'path': 'none',
              'state': 'pending',
              'directoryHint': {
                'dirId': 'dir_target',
                'reason': '这段一直在改目标项目的代码',
              },
            },
          ],
        });
      }
      if (path == '/api/air') {
        return json({
          'directories': [
            {'id': 'dir_target', 'name': '目标项目', 'path': '/tmp/target'},
          ],
          'tasks': [],
          'sessions': [],
          'clis': [],
          'taskPins': [],
          'taskTodos': [],
        });
      }
      if (path == '/api/external-fleets') {
        return json({'ok': true, 'fleets': []});
      }
      if (path == '/api/task-board/tasks/tsk_from/relocate') {
        expect(jsonDecode(request.body)['dirId'], 'dir_target');
        return json({'ok': false, 'error': 'task_busy'}, 409);
      }
      if (path ==
          '/api/task-shells/shell1/attribution-decisions/dec_1/dismiss') {
        dismissed = true;
        return json({'id': 'dec_1', 'state': 'dismissed'});
      }
      return http.Response('not found', 404);
    });

    await tester.pumpWidget(
      MaterialApp(
        home: TaskDirectoryHintPrompt(
          events: events.stream,
          shellId: 'shell1',
          settings: settings,
          httpClient: client,
          child: const Scaffold(body: Text('Chat')),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsOneWidget);
    expect(
      find.text(
        t('taskDirectoryHintBody', {'dir': '目标项目', 'reason': '这段一直在改目标项目的代码'}),
      ),
      findsOneWidget,
    );

    await tester.tap(find.text(t('taskDirectoryHintMove')));
    await tester.pumpAndSettle();
    expect(find.text(t('taskDirectoryHintBusy')), findsOneWidget);
    expect(find.byType(AlertDialog), findsOneWidget);

    await tester.tap(find.text(t('taskDirectoryHintIgnore')));
    await tester.pumpAndSettle();
    expect(dismissed, isTrue);
    expect(find.byType(AlertDialog), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await events.close();
    client.close();
  });
}
