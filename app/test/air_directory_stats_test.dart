import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:multicc_app/widgets/air/air_task_status.dart';

AirTask task(
  String id, {
  String status = 'active',
  String? runState,
  int updatedAt = 0,
}) => AirTask(
  id: id,
  dirId: 'd',
  title: id,
  status: status,
  recordType: '',
  updatedAt: updatedAt,
  readOnly: false,
  runState: runState,
);

void main() {
  // 统计格的「待办」标签来自词典（airTodoFilter）。
  setUpAll(() => I18n.init('zh'));

  final now = DateTime.now();
  final midnight = DateTime(now.year, now.month, now.day);
  final today = midnight.millisecondsSinceEpoch + 1;
  final tasks = [
    task('running', runState: 'running'),
    task('waiting', runState: 'waiting'),
    task('error', runState: 'error'),
    task('success', runState: 'succeeded', updatedAt: today + 1),
    task('legacy', status: 'done', runState: 'succeeded', updatedAt: today),
    task('archived', status: 'archived', runState: 'running'),
  ];

  test(
    'shared filters distinguish execution success from completion today',
    () {
      for (final filter in [
        AirDirectoryTaskFilter.running,
        AirDirectoryTaskFilter.waiting,
        AirDirectoryTaskFilter.error,
        AirDirectoryTaskFilter.succeeded,
      ]) {
        expect(tasks.where(filter.matches).length, 1, reason: filter.name);
      }
      expect(tasks.where(AirDirectoryTaskFilter.today.matches).length, 2);
      expect(tasks.where(AirDirectoryTaskFilter.all.matches).length, 6);
      expect(tasks.where(AirDirectoryTaskFilter.open.matches).length, 4);
      expect(tasks.where(AirDirectoryTaskFilter.archived.matches).length, 1);
      // 「待办」和目录统计格同源：等待 + 出错，归档的不算。
      expect(tasks.where(AirDirectoryTaskFilter.todo.matches).length, 2);
    },
  );

  test('被忽略的异常：不在待办里，但仍在异常口径里', () {
    final ignoredError = AirTask(
      id: 'ignored-error',
      dirId: 'd',
      title: 'ignored-error',
      status: 'active',
      recordType: '',
      updatedAt: 0,
      readOnly: false,
      runState: 'error',
      todoIgnored: true,
    );
    expect(AirDirectoryTaskFilter.todo.matches(ignoredError), isFalse);
    expect(AirDirectoryTaskFilter.error.matches(ignoredError), isTrue);
    expect([ignoredError].where(AirDirectoryTaskFilter.todo.matches), isEmpty);
    expect(
      [ignoredError].where(AirDirectoryTaskFilter.error.matches).length,
      1,
    );
  });

  test(
    'done-today uses local midnight for succeeded and legacy done tasks',
    () {
      final fixedNow = DateTime(2026, 10, 10, 12);
      final fixedMidnight = DateTime(2026, 10, 10).millisecondsSinceEpoch;
      expect(
        airTaskDoneToday(
          task('fresh', runState: 'succeeded', updatedAt: fixedMidnight),
          fixedNow,
        ),
        isTrue,
      );
      expect(
        airTaskDoneToday(
          task('done', status: 'done', updatedAt: fixedMidnight),
          fixedNow,
        ),
        isTrue,
      );
      expect(
        airTaskDoneToday(
          task('old', runState: 'succeeded', updatedAt: fixedMidnight - 1),
          fixedNow,
        ),
        isFalse,
      );
    },
  );

  for (final width in [320.0, 430.0, 1280.0]) {
    testWidgets('five counters are clickable without overflow at $width px', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 932);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      AirDirectoryTaskFilter? selected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirDirectoryStats(
              tasks: tasks,
              worktreeCount: 2,
              onFilter: (f) => selected = f,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final filter in [
        AirDirectoryTaskFilter.running,
        AirDirectoryTaskFilter.todo,
        AirDirectoryTaskFilter.error,
        AirDirectoryTaskFilter.today,
        AirDirectoryTaskFilter.all,
      ]) {
        await tester.tap(find.byKey(ValueKey('air-stat-${filter.name}')));
        expect(selected, filter);
      }
      for (final label in ['进行中', '待办', '异常', '今日完成', '全部']) {
        expect(find.text(label), findsOneWidget);
      }
      // 进行中 1 · 待办 2 · 异常 1 · 今日完成 2 · 全部 6
      expect(find.text('1'), findsNWidgets(2));
      expect(find.text('2'), findsNWidgets(2));
      expect(find.text('6'), findsOneWidget);
      expect(find.text('今天跑完的任务'), findsOneWidget);
      expect(find.text('1 个已归档 · 2 个 WT'), findsOneWidget);
      expect(find.text('已完成'), findsNothing);
      expect(find.text('计划任务'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('目录统计格：待办数字 = airTaskTodo；被忽略的异常只退出待办', (tester) async {
    final waiting = task('waiting', runState: 'waiting');
    final ignoredError = AirTask(
      id: 'ignored-error',
      dirId: 'd',
      title: 'ignored-error',
      status: 'active',
      recordType: '',
      updatedAt: 0,
      readOnly: false,
      runState: 'error',
      todoIgnored: true,
    );
    final rows = [waiting, ignoredError];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AirDirectoryStats(tasks: rows)),
      ),
    );
    await tester.pumpAndSettle();

    Finder tileText(String id, String text) => find.descendant(
      of: find.byKey(ValueKey('air-stat-$id')),
      matching: find.text(text),
    );
    expect(tileText('todo', '待办'), findsOneWidget);
    expect(
      tileText('todo', '${airTodoTasks(rows).length}'),
      findsOneWidget,
      reason: '统计格与 airTodoTasks 同一份口径',
    );
    expect(tileText('todo', '1'), findsOneWidget);
    expect(
      rows.where(AirDirectoryTaskFilter.error.matches).length,
      1,
      reason: '被忽略的异常仍在异常口径里',
    );
    expect(
      tileText('error', '1'),
      findsOneWidget,
      reason: '被忽略的异常仍计入异常格',
    );
    expect(tester.takeException(), isNull);
  });
}
