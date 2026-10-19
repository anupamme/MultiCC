import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUpAll(() => I18n.init('zh'));
  for (final width in [390.0, 1200.0]) {
    testWidgets(
      'indexed home at $width: complete counts, shared bootstrap, real server pagination',
      (tester) async {
        SharedPreferences.setMockInitialValues({
          'multicc_host': 'http://localhost:3000',
          OnboardingStore.doneKey: '1',
        });
        final settings = await SettingsService.getInstance();
        final calls = <Uri>[];
        final tasks = [
          for (var i = 0; i < 1278; i++)
            {
              'id': 't$i',
              'dirId': 'd',
              'title': 'Indexed $i',
              'status': 'active',
              'runState': i < 11
                  ? 'waiting'
                  : i >= 100 && i < 125
                  ? 'running'
                  : 'idle',
              'updatedAt': i,
            },
        ];
        final stats = {
          'total': 1278,
          'open': 1278,
          'needs': 11,
          'running': 25,
          'error': 0,
          'todo': 0,
          'today': 0,
          'archived': 0,
        };
        final client = MockClient((req) async {
          calls.add(req.url);
          Object body = <String, dynamic>{'ok': true};
          if (req.url.path == '/api/air/sync') {
            body = {
              'ok': true,
              'cursor': 'boot:1',
              'tasks': tasks.take(2).toList(),
              'directories': [
                {'id': 'd', 'name': 'Indexed project', 'path': '/project'},
              ],
              'clis': ['codex'],
              'taskStats': {'all': stats, 'd': stats},
            };
          } else if (req.url.path == '/api/air/page') {
            final q = req.url.queryParameters;
            final ids = q['ids']?.split(',');
            final rows = tasks
                .where(
                  (t) =>
                      (q['status'] != 'needs' || t['runState'] == 'waiting') &&
                      (q['status'] != 'running' ||
                          t['runState'] == 'running') &&
                      (q['query'] == null ||
                          '${t['title']}'.toLowerCase().contains(
                            q['query']!.toLowerCase(),
                          )) &&
                      (ids == null || ids.contains(t['id'])),
                )
                .toList();
            final page = int.parse(q['page'] ?? '1'),
                limit = int.parse(q['limit'] ?? '20');
            body = {
              'ok': true,
              'cursor': 'boot:1',
              'page': page,
              'pages': (rows.length / limit).ceil().clamp(1, 999),
              'total': rows.length,
              'tasks': rows.skip((page - 1) * limit).take(limit).toList(),
            };
          } else if (req.url.path == '/api/auth/ws-ticket') {
            return http.Response('{}', 503);
          } else if (req.url.path == '/api/cron' ||
              req.url.path == '/api/docs-registry') {
            body = [];
          } else if (req.url.path == '/api/aux/config') {
            body = {
              'providerId': 'configured',
              'cliAvailability': {'codex': true},
            };
          }
          return http.Response(
            jsonEncode(body),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        });
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 844);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await tester.pumpWidget(
          MaterialApp(
            home: AirTasksView(settings: settings, httpClient: client),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          calls.where((u) => u.path == '/api/air/sync'),
          hasLength(1),
          reason: 'console and shell share one bootstrap',
        );
        expect(calls.where((u) => u.path == '/api/air'), isEmpty);
        if (width < 760) {
          expect(find.textContaining('11'), findsWidgets);
          await tester.tap(
            find.byKey(const ValueKey('air-mobile-console-all')),
          );
          await tester.pumpAndSettle();
          final next = find.byKey(
            const ValueKey('air-mobile-recent-page-next'),
          );
          await tester.scrollUntilVisible(
            next,
            400,
            scrollable: find
                .descendant(
                  of: find.byKey(const PageStorageKey('mobile-recent-scroll')),
                  matching: find.byType(Scrollable),
                )
                .first,
          );
          await tester.tap(next);
          await tester.pumpAndSettle();
          expect(
            calls.any(
              (u) =>
                  u.path == '/api/air/page' && u.queryParameters['page'] == '2',
            ),
            isTrue,
          );
          // Loading the next page returns to the start of the lazy list.
          await tester.scrollUntilVisible(
            next,
            400,
            scrollable: find
                .descendant(
                  of: find.byKey(const PageStorageKey('mobile-recent-scroll')),
                  matching: find.byType(Scrollable),
                )
                .first,
          );
          expect(find.text('第 2 / 64 页'), findsOneWidget);
        } else {
          await tester.tap(find.byKey(const ValueKey('air-header-menu')));
          await tester.pumpAndSettle();
          await tester.tap(find.text('工作目录库'));
          await tester.pumpAndSettle();
          expect(find.textContaining('1278 个任务'), findsWidgets);
          await tester.tap(find.byKey(const ValueKey('air-directory-d')));
          await tester.pumpAndSettle();
          final next = find.byKey(const ValueKey('air-tasks-page-next'));
          await tester.ensureVisible(next);
          await tester.pumpAndSettle();
          await tester.tap(next);
          await tester.pumpAndSettle();
          expect(find.text('第 2 / 64 页'), findsOneWidget);
          expect(
            find.byKey(const ValueKey('air-directory-task-t20')),
            findsOneWidget,
          );
          expect(
            find.byKey(const ValueKey('air-directory-task-t0')),
            findsNothing,
          );
          await tester.tap(find.text('执行中 25'));
          await tester.pumpAndSettle();
          expect(find.text('正在执行 25 个任务'), findsOneWidget);
          expect(find.text('Indexed 100'), findsOneWidget);
          await tester.tap(find.byKey(const ValueKey('air-running-page-next')));
          await tester.pumpAndSettle();
          expect(find.text('第 2 / 2 页'), findsOneWidget);
          expect(find.text('Indexed 120'), findsOneWidget);
          Navigator.of(tester.element(find.text('正在执行 25 个任务'))).pop();
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('air-header-menu')));
          await tester.pumpAndSettle();
          await tester.tap(find.text('搜索目录与任务'));
          await tester.pumpAndSettle();
          await tester.enterText(
            find.byKey(const ValueKey('air-palette-input')),
            'Indexed 1200',
          );
          await tester.pumpAndSettle();
          expect(
            find.text('Indexed 1200'),
            findsWidgets,
            reason:
                'global search finds a task absent from bootstrap and loaded pages',
          );
          expect(
            calls.where(
              (u) =>
                  u.path == '/api/air/page' &&
                  u.queryParameters['status'] == 'running' &&
                  u.queryParameters['page'] == '2',
            ),
            hasLength(1),
          );
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        client.close();
      },
    );
  }
}
