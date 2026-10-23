import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/utils/session_status_helpers.dart';
import 'package:multicc_app/utils/status_presentation.dart';
import 'package:multicc_app/widgets/aux_classify_bar.dart';

/// 分类条右侧的两个动作药丸，对齐 web 的 `#aux-classify-bar`：
/// W → 「✓ 执行成功」，P → 「✕ 取消」，其余状态一个都不给。
///
/// 显隐规则抽在 [classifyBarActions] 里，这里既钉纯函数（规则本身），也钉
/// widget 的接线（回调传了才渲染、点了真的回调）。
Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 360, child: child)),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  group('classifyBarActions', () {
    test('W 只给执行成功，P 只给取消', () {
      expect(classifyBarActions('W'), (
        canMarkDone: true,
        canCancelTask: false,
      ));
      expect(classifyBarActions('P'), (
        canMarkDone: false,
        canCancelTask: true,
      ));
    });

    test('大小写不敏感', () {
      expect(classifyBarActions('w').canMarkDone, isTrue);
      expect(classifyBarActions('p').canCancelTask, isTrue);
    });

    test('其余状态两个都不给', () {
      for (final state in ['D', 'C', 'B', 'E']) {
        final actions = classifyBarActions(state);
        expect(actions.canMarkDone, isFalse, reason: state);
        expect(actions.canCancelTask, isFalse, reason: state);
      }
    });

    test('缺省按 web 的 || P 兜底：能给的是「能叫停」而不是「已完成」', () {
      for (final state in [null, '', '  ']) {
        final actions = classifyBarActions(state);
        expect(actions.canCancelTask, isTrue, reason: '$state');
        expect(actions.canMarkDone, isFalse, reason: '$state');
      }
    });
  });

  testWidgets('P 状态渲染 ✕ 取消，点击触发回调', (tester) async {
    var cancels = 0;
    await tester.pumpWidget(
      _host(
        AuxClassifyBar(
          goal: '修好登录流程',
          phase: 'running',
          classifyState: 'P',
          onCancelTurn: () => cancels++,
        ),
      ),
    );

    expect(find.text('✕ 取消'), findsOneWidget);
    expect(find.byKey(const Key('classify-cancel-turn')), findsOneWidget);
    expect(find.text('✓ 执行成功'), findsNothing);

    await tester.tap(find.byKey(const Key('classify-cancel-turn')));
    await tester.pump();
    expect(cancels, 1);
  });

  testWidgets('W 状态渲染 ✓ 执行成功，且不出现取消药丸', (tester) async {
    var marks = 0;
    await tester.pumpWidget(
      _host(
        AuxClassifyBar(
          goal: '修好登录流程',
          phase: 'waiting',
          classifyState: 'W',
          onMarkTurnSucceeded: () => marks++,
        ),
      ),
    );

    expect(find.text('✓ 执行成功'), findsOneWidget);
    expect(find.byKey(const Key('classify-cancel-turn')), findsNothing);
    expect(find.text('✕ 取消'), findsNothing);

    await tester.tap(find.text('✓ 执行成功'));
    await tester.pump();
    expect(marks, 1);
  });

  testWidgets('D 状态（完成）两个药丸都不渲染', (tester) async {
    await tester.pumpWidget(
      _host(
        const AuxClassifyBar(goal: '修好登录流程', phase: 'done', classifyState: 'D'),
      ),
    );

    // 目标与状态徽章仍在，只是没有可点的动作。
    expect(find.text('修好登录流程'), findsOneWidget);
    expect(find.byKey(const Key('classify-cancel-turn')), findsNothing);
    expect(find.byKey(const Key('classify-mark-succeeded')), findsNothing);
    // 状态药丸本身说「执行成功」，与任务卡同词。
    expect(find.text('✓ 执行成功'), findsOneWidget);
  });

  testWidgets('D 的子状态与任务卡同词同色（succeededSubLabel + succeededGoalTone）', (
    tester,
  ) async {
    Color colorOf(String text) =>
        tester.widget<Text>(find.text(text)).style!.color!;
    for (final (goalState, word, tone) in [
      ('achieved', '✓ 达成目标', ''),
      ('interact', '✓ 需要交互', 'interact'),
      (null, '✓ 执行成功', 'muted'),
    ]) {
      await tester.pumpWidget(
        _host(
          AuxClassifyBar(
            goal: 'g',
            phase: 'done',
            classifyState: 'D',
            goalState: goalState,
          ),
        ),
      );
      expect(find.text(word), findsOneWidget, reason: '$goalState');
      expect(succeededGoalTone('succeeded', goalState), tone);
      expect(
        colorOf(word),
        tone.isEmpty
            ? statusPresentation[CanonicalStatus.succeeded]!.color
            : statusToneColor(tone),
        reason: '$goalState',
      );
    }
  });

  testWidgets('「需要交互」长按药丸浮出确认小窗，点确认才改标', (tester) async {
    var marks = 0;
    Widget bar(String goalState) => _host(
      AuxClassifyBar(
        goal: 'g',
        phase: 'verifying',
        classifyState: 'D',
        goalState: goalState,
        onMarkGoalAchieved: () => marks++,
      ),
    );
    await tester.pumpWidget(bar('interact'));
    // 轻点不弹。
    await tester.tap(find.byKey(const Key('classify-goal-pill')));
    await tester.pumpAndSettle();
    expect(find.text('将状态改为「达成目标」？'), findsNothing);
    // 长按弹出；点小窗外关闭，不改标。
    await tester.longPress(find.byKey(const Key('classify-goal-pill')));
    await tester.pumpAndSettle();
    expect(find.text('将状态改为「达成目标」？'), findsOneWidget);
    await tester.tapAt(const Offset(5, 500));
    await tester.pumpAndSettle();
    expect(find.text('将状态改为「达成目标」？'), findsNothing);
    expect(marks, 0);
    // 再长按，点确认 → 回调一次，小窗收起。
    await tester.longPress(find.byKey(const Key('classify-goal-pill')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('classify-goal-pop-confirm')));
    await tester.pumpAndSettle();
    expect(marks, 1);
    expect(find.text('将状态改为「达成目标」？'), findsNothing);
    // 已是「达成目标」：药丸不再可长按。
    await tester.pumpWidget(bar('achieved'));
    expect(find.byKey(const Key('classify-goal-pill')), findsNothing);
  });

  group('实时读数并进状态药丸位', () {
    // 回合在跑时的 liveness 判定。silentMs 只有 ≥5s 才附时长（见 livenessChip）。
    Map<String, dynamic> verdict(String state, {int silentMs = 0}) => {
      'state': state,
      'stage': 'request',
      'stagePrecise': false,
      'silentMs': silentMs,
    };

    testWidgets('在跑：同一行显示目标 + 实时读数 + 取消，没有第二条横条', (tester) async {
      await tester.pumpWidget(
        _host(
          AuxClassifyBar(
            goal: '把 Rust CPR 改动合入 main',
            phase: 'planning',
            classifyState: 'P',
            liveness: verdict('working', silentMs: 8000),
            onCancelTurn: () {},
          ),
        ),
      );

      // 目标与动作都还在这一行里。
      expect(find.text('把 Rust CPR 改动合入 main'), findsOneWidget);
      expect(find.byKey(const Key('classify-cancel-turn')), findsOneWidget);
      // 实时读数占的是状态药丸位：阶段词让位，不并列挤占目标的宽度。
      expect(find.text('🟢 请求/思考中 · 8s'), findsOneWidget);
      expect(find.textContaining('规划中'), findsNothing);
    });

    testWidgets('静息：读数退场，状态药丸位还回阶段词', (tester) async {
      await tester.pumpWidget(
        _host(
          const AuxClassifyBar(
            goal: '把 Rust CPR 改动合入 main',
            phase: 'planning',
            classifyState: 'P',
            onCancelTurn: null,
          ),
        ),
      );

      expect(find.textContaining('规划中'), findsOneWidget);
      expect(find.textContaining('请求/思考中'), findsNothing);
    });

    testWidgets('没有分类目标时只画读数本身，不画空的目标位', (tester) async {
      await tester.pumpWidget(
        _host(
          AuxClassifyBar(
            goal: '',
            phase: 'idle',
            classifyState: 'P',
            liveness: verdict('stalled', silentMs: 65000),
          ),
        ),
      );

      expect(find.text('🔴 疑似卡住 · 1m 5s'), findsOneWidget);
      expect(find.byIcon(Icons.auto_awesome_outlined), findsNothing);
    });
  });
}
