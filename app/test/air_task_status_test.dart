import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/utils/status_presentation.dart';
import 'package:multicc_app/widgets/air/air_task_status.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';

/// 造一条任务，只给这一份判定真正会读的字段。
AirTask _task({
  String id = 't1',
  String dirId = 'd1',
  String status = 'active',
  String? runState,
  String? goalState,
  String? workflowStage,
  String recordType = '',
  Map<String, dynamic> resource = const {},
  AirWorktreeChanges? worktreeChanges,
  int updatedAt = 0,
  int lastMessageAt = 0,
  bool manualTodo = false,
  bool todoIgnored = false,
}) => AirTask(
  id: id,
  dirId: dirId,
  title: '任务 $id',
  status: status,
  recordType: recordType,
  updatedAt: updatedAt,
  lastMessageAt: lastMessageAt,
  readOnly: false,
  workflowStage: workflowStage,
  runState: runState,
  goalState: goalState,
  resource: resource,
  worktreeChanges: worktreeChanges,
  manualTodo: manualTodo,
  todoIgnored: todoIgnored,
);

void main() {
  // Air 词表出自注册表的 airLabelKey 列，取词走 t()，所以词典得先装好 —— 不然
  // 拿到的是 key 本身。
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  test('任务卡从快照读取绑定的 Provider 名称，不从全局默认值猜', () {
    final bound = AirTask.fromJson({
      'id': 'bound', 'dirId': 'd1', 'title': '任务', 'status': 'active',
      'recordType': 'planned', 'updatedAt': 0, 'readOnly': false,
      'providerName': '智谱',
    });
    final unbound = AirTask.fromJson({
      'id': 'unbound', 'dirId': 'd1', 'title': '任务', 'status': 'active',
      'recordType': 'planned', 'updatedAt': 0, 'readOnly': false,
    });
    expect(bound.providerName, '智谱');
    expect(unbound.providerName, isNull);
  });

  testWidgets('任务行显示已绑定 Provider，无绑定时不显示', (tester) async {
    AirTask task(String id, String? providerName) => AirTask(
      id: id, dirId: 'd1', title: '任务 $id', status: 'active',
      recordType: 'planned', updatedAt: 0, readOnly: false,
      providerName: providerName,
    );
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Column(children: [
      AirTaskTile(task: task('bound', '智谱'), onTap: () {}),
      AirTaskTile(task: task('unbound', null), onTap: () {}),
    ]))));
    expect(find.textContaining('智谱'), findsOneWidget);
    expect(find.textContaining('默认线路'), findsNothing);
  });

  group('一条任务算什么', () {
    test('生命周期最优先：归档和完成不因为这一轮在跑就被改写成执行中', () {
      expect(
        airTaskStatus(_task(status: 'archived', runState: 'running')),
        CanonicalStatus.archived,
      );
      expect(
        airTaskStatus(_task(status: 'done', runState: 'running')),
        CanonicalStatus.done,
      );
    });

    test('status 只有三个生命周期取值，「在不在跑」只能从 runState 读', () {
      expect(
        airTaskStatus(_task(runState: 'running')),
        CanonicalStatus.running,
      );
      expect(
        airTaskStatus(_task(runState: 'waiting')),
        CanonicalStatus.waiting,
      );
      // active 但什么都没在跑，是空闲，不是执行中 —— 这正是从前按
      // `status == 'active'` 数「执行中」会数错的那一批。
      expect(airTaskStatus(_task()), CanonicalStatus.idle);
      expect(airTaskRunning(_task()), isFalse);
    });

    test('只有 runState=running 会转圈：出错的任务绝不动画', () {
      expect(airTaskRunning(_task(runState: 'running')), isTrue);
      expect(airTaskRunning(_task(runState: 'error')), isFalse);
      expect(airTaskRunning(_task(runState: 'queued')), isFalse);
      expect(
        airTaskStatus(_task(runState: 'error')),
        CanonicalStatus.error,
      );
    });

    test('认不出来的 runState 落 unknown，不猜成成功也不猜成在跑', () {
      expect(
        airTaskStatus(_task(runState: '前所未见的状态')),
        CanonicalStatus.unknown,
      );
    });
  });

  group('等我处理', () {
    test('等待回答 / 出错 / 需要交互 / 手动标记都算，跑着的不算', () {
      expect(airTaskNeedsMe(_task(runState: 'waiting')), isTrue);
      expect(airTaskNeedsMe(_task(runState: 'error')), isTrue);
      expect(
        airTaskNeedsMe(_task(runState: 'succeeded', goalState: 'interact')),
        isTrue,
      );
      expect(
        airTaskNeedsMe(_task(runState: 'succeeded', goalState: 'achieved')),
        isFalse,
      );
      // 手动标记：哪怕这一轮空闲着也留着，直到用户自己取消。
      expect(airTaskNeedsMe(_task(manualTodo: true)), isTrue);
      // 跑着 / 等后台任务：有东西在外面跑，不需要我操作。
      expect(airTaskNeedsMe(_task(runState: 'running')), isFalse);
      expect(airTaskNeedsMe(_task(runState: 'background')), isFalse);
      expect(airTaskNeedsMe(_task()), isFalse);
      expect(airTaskNeedsMe(_task(status: 'done')), isFalse);
      expect(airTaskNeedsMe(_task(status: 'archived')), isFalse);
      // 卡在资源只说明还没轮到它跑，不是要人回答 / 处理的那一类。
      expect(
        airTaskNeedsMe(
          _task(
            runState: 'idle',
            resource: const {'capacityReason': 'workspace_execution_capacity'},
          ),
        ),
        isFalse,
      );
      // 旧名是同一份判定。
      expect(airTaskTodo(_task(runState: 'waiting')), isTrue);
    });

    test('清单只收等我处理的：在跑的不列，空闲 / 已结束的也不列', () {
      final rows = airNeedsMeTasks([
        _task(id: 'idle', runState: 'idle'),
        _task(id: 'done', status: 'done'),
        _task(id: 'run', runState: 'running', updatedAt: 999),
        _task(id: 'wait', runState: 'waiting', updatedAt: 100),
        _task(id: 'bad', runState: 'error', updatedAt: 200),
      ]);
      expect(rows.map((t) => t.id).toList(), ['wait', 'bad']);
    });

    test('清单按最早的消息时间升序，不按紧急度分层（同 Web）', () {
      final rows = airNeedsMeTasks([
        _task(id: 'old', runState: 'waiting', updatedAt: 100),
        _task(id: 'err', runState: 'error', updatedAt: 999),
        _task(id: 'new', runState: 'waiting', updatedAt: 200),
      ]);
      // 按紧急度分层会得到 wait · error；最早的消息在前只会是 old · new · err。
      expect(rows.map((t) => t.id).toList(), ['old', 'new', 'err']);
    });

    test('手动待办进清单、忽略的不进；排序看最早消息而不是更新时间', () {
      final rows = airNeedsMeTasks([
        _task(
          id: 'ignored',
          runState: 'waiting',
          todoIgnored: true,
          lastMessageAt: 1,
        ),
        _task(
          id: 'manual',
          manualTodo: true,
          updatedAt: 900,
          lastMessageAt: 900,
        ),
        _task(
          id: 'older',
          runState: 'waiting',
          updatedAt: 999,
          lastMessageAt: 100,
        ),
      ]);
      expect(rows.map((t) => t.id).toList(), ['older', 'manual']);
      // 旧名仍指向同一份清单。
      expect(airTodoTasks(rows).map((t) => t.id), ['older', 'manual']);
    });

    test('有任务在跑的目录才带标记', () {
      expect(
        airRunningDirectories([
          _task(id: 'a', dirId: 'd1', runState: 'running'),
          _task(id: 'b', dirId: 'd2', runState: 'waiting'),
          _task(id: 'c', dirId: 'd3', runState: 'idle'),
        ]),
        {'d1'},
      );
    });
  });

  group('Air 徽标说 Air 词表', () {
    test('词从注册表的 airLabelKey 列取，跟词典里那几个词不是一个说法', () {
      // App 词典里 running 是「进行中」、waiting 是「等待中」；Air 面说的是另一套 ——
      // 注册表 airLabelKey 那一列（Web `air-admin.js` 的 STATUS_COPY、`air.js` 的
      // stateNames 都由它构建），跟侧栏那些阶段、资源去向（`airLabel`）同源。
      expect(airStatusLabel(CanonicalStatus.running), '执行中');
      expect(airStatusLabel(CanonicalStatus.waiting), '等待回答');
      expect(airStatusLabel(CanonicalStatus.blocked), '等待配置');
      expect(airStatusLabel(CanonicalStatus.error), '执行异常');
      expect(airStatusLabel(CanonicalStatus.succeeded), '执行成功');
      expect(airStatusLabel(CanonicalStatus.unknown), '状态未知');
      // 等后台任务是它自己的词，不是「等待回答」—— 那张卡上没有东西要人回答。
      expect(airStatusLabel(CanonicalStatus.background), '等待后台任务');
      expect(
        airStatusLabel(CanonicalStatus.background),
        isNot(airStatusLabel(CanonicalStatus.waiting)),
      );
      // 每个状态一个不落、一个词也不重：两个状态共用一个词，折叠就又隐身了。
      final words = <String>{};
      for (final status in CanonicalStatus.values) {
        final word = airStatusCopy()[status];
        expect(word, isNotNull, reason: '$status 缺词');
        expect(word, isNot(status.name), reason: '$status 落回了状态名');
        expect(words.add(word!), isTrue, reason: '$status 和别的状态同词：$word');
      }
    });

    test('一行上不会出现两个词说同一件事', () {
      // 在跑的任务：徽标「执行中」，第二层不该再说一遍（租约也是 running）。
      final running = _task(runState: 'running', resource: const {'lease': 'running'});
      expect(airStatusLabel(airTaskStatus(running)), '执行中');
      expect(airTaskDetail(running), '');
    });
  });

  group('✅ 那一格的三个说法', () {
    test('子状态换的只是词，图标/色调/状态本身都不动', () {
      // 判定在服务端（src/classify/vocab.js goalStateForClassify），客户端只读
      // goalState 换词；换不到的（没目标、认不出的值）落回「执行成功」。
      expect(succeededSubLabel(CanonicalStatus.succeeded, 'achieved'), '达成目标');
      expect(succeededSubLabel(CanonicalStatus.succeeded, 'interact'), '需要交互');
      expect(succeededSubLabel(CanonicalStatus.succeeded, null), '');
      expect(succeededSubLabel(CanonicalStatus.succeeded, 'wat'), '');
      // 子状态只挂在 ✅ 上：别的状态一个字都不换。
      for (final status in CanonicalStatus.values) {
        if (status == CanonicalStatus.succeeded) continue;
        expect(succeededSubLabel(status, 'achieved'), '', reason: '$status 借用了 ✅ 的子状态词');
      }
      // 徽标本体：状态没变、颜色没变，只有可见文案换了一个。
      final achieved = _task(runState: 'succeeded', goalState: 'achieved');
      expect(airTaskStatus(achieved), CanonicalStatus.succeeded);
      expect(airTaskSpec(achieved).icon, '✓');
    });

    testWidgets('徽标画出的是子状态那个词', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: AirTaskStatusBadge(task: _task(runState: 'succeeded', goalState: 'achieved')),
        ),
      ));
      expect(find.text('达成目标'), findsOneWidget);
      expect(find.text('执行成功'), findsNothing);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: AirTaskStatusBadge(task: _task(runState: 'succeeded', goalState: 'interact')),
        ),
      ));
      expect(find.text('需要交互'), findsOneWidget);

      // 没有子状态（旧服务端 / 没有目标）时还是老样子。
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: AirTaskStatusBadge(task: _task(runState: 'succeeded'))),
      ));
      expect(find.text('执行成功'), findsOneWidget);
    });

    test('第二层信息跟徽标实际印的那个词比，不跟粗的词比', () {
      // 徽标印的是子状态的词，所以「有没有重复说」要以它为准：资源那句话正好
      // 等于徽标上的词时仍然只印一次（同 Web 那句 `!badgeText.includes(part)`）。
      final task = _task(
        runState: 'succeeded',
        goalState: 'achieved',
        resource: const {'lease': 'running'},
      );
      expect(airTaskDetail(task), '执行中');
    });
  });

  group('worktree 待交付图标', () {
    test('未提交、未合并和两者同时存在时，提示各说各的', () {
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(dirty: true),
      )), 'Worktree 有未提交改动');
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(ahead: 3),
      )), 'Worktree 有 3 个提交尚未合并');
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(dirty: true, ahead: 2),
      )), 'Worktree 有未提交改动，另有 2 个提交尚未合并');
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(),
      )), '');
    });
  });

  group('行上的第二层信息', () {
    test('计划 + 阶段 + 资源去向，合起来一句话', () {
      expect(
        airTaskDetail(
          _task(
            recordType: 'planned',
            workflowStage: 'inbox',
            resource: const {'residency': 'planned'},
          ),
        ),
        '计划 · 待处理 · 执行时准备目录',
      );
    });

    test('资源那句话说不出新东西时就不重复一遍', () {
      // 目录已准备 + 阶段就是「目录已准备」：说两遍不如说一遍。
      expect(
        airTaskDetail(
          _task(
            workflowStage: 'resident',
            resource: const {'residency': 'resident'},
          ),
        ),
        '目录已准备',
      );
    });

    test('观察型记录不说阶段：这正是「满屏进行中」的来源', () {
      // `status` 是生命周期（active/done/archived），不是「在不在跑」。老写法拿它
      // 兜底当阶段，于是每条没跑的任务都在这一行写「进行中」，跟同一行的徽标
      // （空闲 / 执行成功 / 等待回答）说反话。
      expect(airTaskDetail(_task()), '', reason: '观察型记录没有阶段，也没有资源去向');
      expect(
        airTaskDetail(_task(status: 'done')),
        '',
        reason: '已完成也不该在这里写「进行中」—— 徽标已经说了',
      );
      // 有真话可说的时候照说：卡在名额上就得写出来。
      expect(
        airTaskDetail(
          _task(runState: 'waiting', resource: const {
            'capacityReason': 'workspace_execution_capacity',
          }),
        ),
        '等待执行名额',
      );
    });

    test('徽标说过的词不在第二层再说一遍（同 Web 侧栏）', () {
      expect(
        airTaskDetail(_task(runState: 'running', resource: const {'lease': 'running'})),
        '',
        reason: '徽标「执行中」+ 这行「执行中」不是更多信息',
      );
      // 阶段和资源去向撞词时同理（planned 记录才有阶段）。
      expect(
        airTaskDetail(
          _task(
            recordType: 'planned',
            workflowStage: 'review',
            resource: const {'lease': 'review'},
          ),
        ),
        '计划 · 待验收',
      );
    });

    test('时间按本地时区写成 月/日 时:分，没时间就不写', () {
      expect(airTaskTime(0), '');
      final at = DateTime(2026, 9, 13, 8, 5);
      expect(
        airTaskTime(at.millisecondsSinceEpoch),
        '9/13 08:05',
      );
    });
  });

  group('等我处理（汇总）与待办（仅手动标记）', () {
    test('等我处理含四类；待办只收手动标记的那一类', () {
      final needsMe = AirDirectoryTaskFilter.needsMe;
      expect(needsMe.matches(_task(runState: 'waiting')), isTrue);
      expect(needsMe.matches(_task(runState: 'error')), isTrue);
      expect(
        needsMe.matches(_task(runState: 'succeeded', goalState: 'interact')),
        isTrue,
      );
      expect(
        needsMe.matches(_task(runState: 'succeeded', goalState: 'achieved')),
        isFalse,
      );
      expect(needsMe.matches(_task(runState: 'running')), isFalse);
      expect(needsMe.matches(_task(runState: 'idle')), isFalse);
      expect(needsMe.matches(_task(status: 'archived', runState: 'waiting')), isFalse);

      // 「待办」不再等于汇总：只有手动标记的才进来。
      final todo = AirDirectoryTaskFilter.todo;
      expect(todo.matches(_task(runState: 'waiting')), isFalse);
      expect(todo.matches(_task(runState: 'error')), isFalse);
      expect(
        todo.matches(_task(runState: 'succeeded', goalState: 'interact')),
        isFalse,
      );
      final marked = AirTask.fromJson(const {
        'id': 'm1', 'dirId': 'd1', 'title': 'x', 'status': 'active', 'runState': 'idle',
      }, manualTodo: true);
      expect(todo.matches(marked), isTrue);
      // 手动标记的待办同时也在「等我处理」里。
      expect(needsMe.matches(marked), isTrue);
      // 归档的手动待办仍算「待办」，但不进「等我处理」。
      final archivedMarked = AirTask.fromJson(const {
        'id': 'm2', 'dirId': 'd1', 'title': 'x', 'status': 'archived',
      }, manualTodo: true);
      expect(todo.matches(archivedMarked), isTrue);
      expect(needsMe.matches(archivedMarked), isFalse);
    });

    test('快照的 taskTodos 回填到每一行上', () {
      final snapshot = AirSnapshot.fromJson(const {
        'directories': [],
        'taskTodos': ['t2'],
        'tasks': [
          {'id': 't1', 'dirId': 'd1', 'title': 'a', 'status': 'active'},
          {'id': 't2', 'dirId': 'd1', 'title': 'b', 'status': 'active'},
        ],
      });
      expect(snapshot.taskTodos, ['t2']);
      expect(snapshot.isTodo('t2'), isTrue);
      expect(snapshot.tasks.map((t) => t.manualTodo), [false, true]);
      expect(AirSnapshot.fromJson(const {'tasks': []}).taskTodos, isEmpty);
    });

    test('忽略的进不了等我处理；异常口径与「待办」都不受影响', () {
      final needsMe = AirDirectoryTaskFilter.needsMe;
      final ignoredWaiting = _task(runState: 'waiting', todoIgnored: true);
      final ignoredError = _task(runState: 'error', todoIgnored: true);
      final ignoredManual = _task(todoIgnored: true, manualTodo: true);
      expect(needsMe.matches(ignoredWaiting), isFalse);
      expect(needsMe.matches(ignoredError), isFalse);
      expect(needsMe.matches(ignoredManual), isFalse, reason: '忽略压过手动标记');
      expect(
        airNeedsMeTasks([ignoredWaiting, ignoredError, ignoredManual])
            .map((t) => t.id),
        isEmpty,
      );
      // 「已忽略」不再是筛选项；被忽略的异常仍留在异常清单里。
      expect(
        AirDirectoryTaskFilter.values.map((f) => f.name),
        isNot(contains('ignored')),
      );
      final error = AirDirectoryTaskFilter.error;
      expect(error.matches(ignoredError), isTrue);
      expect(error.matches(_task(runState: 'error')), isTrue);
      expect(error.matches(ignoredWaiting), isFalse);
      // 忽略与手动待办互不清除：「待办」仍只看手动标记。
      expect(AirDirectoryTaskFilter.todo.matches(ignoredManual), isTrue);
      // 乐观更新也只是同时铺两份清单，不会顺手把另一边清空。
      final both = AirSnapshot.fromJson(const {
        'tasks': [
          {
            'id': 't1',
            'dirId': 'd1',
            'title': 'a',
            'status': 'active',
          },
        ],
      }).withTodoLists(todos: ['t1'], ignored: ['t1']);
      expect(both.taskTodos, ['t1']);
      expect(both.taskTodoIgnored, ['t1']);
      expect(both.tasks.single.manualTodo, isTrue);
      expect(both.tasks.single.todoIgnored, isTrue);
    });

    test('等我处理清单最早的消息时间在前，同一时间按 id 稳定', () {
      final rows = airNeedsMeTasks([
        _task(id: 'new', runState: 'waiting', updatedAt: 300),
        _task(id: 'old', runState: 'error', updatedAt: 100),
        _task(id: 'mid', runState: 'waiting', updatedAt: 200),
        _task(id: 'b', runState: 'waiting', updatedAt: 150),
        _task(id: 'a', runState: 'waiting', updatedAt: 150),
        _task(id: 'ignored', runState: 'error', updatedAt: 50, todoIgnored: true),
        _task(id: 'idle', runState: 'idle', updatedAt: 25),
      ]);
      // 最老的先来；忽略的和不构成等我处理的不出现。
      expect(rows.map((t) => t.id).toList(), ['old', 'a', 'b', 'mid', 'new']);
    });

    test('快照的 taskTodoIgnored 回填到每一行上，缺省时空清单兼容旧服务', () {
      final snapshot = AirSnapshot.fromJson(const {
        'directories': [],
        'taskTodoIgnored': ['t2'],
        'tasks': [
          {'id': 't1', 'dirId': 'd1', 'title': 'a', 'status': 'active'},
          {'id': 't2', 'dirId': 'd1', 'title': 'b', 'status': 'active'},
        ],
      });
      expect(snapshot.taskTodoIgnored, ['t2']);
      expect(snapshot.isTodoIgnored('t2'), isTrue);
      expect(snapshot.tasks.map((t) => t.todoIgnored), [false, true]);
      final legacy = AirSnapshot.fromJson(const {
        'tasks': [
          {'id': 't1', 'dirId': 'd1', 'title': 'a', 'status': 'active'},
        ],
      });
      expect(legacy.taskTodoIgnored, isEmpty);
      expect(legacy.tasks.single.todoIgnored, isFalse);
    });
  });

  group('唯一动作按钮', () {
    test('优先级：已忽略 > 手动待办 > 状态动作 > 标记待办', () {
      // 已忽略压过一切：先给取消忽略。
      expect(
        airTaskPrimaryAction(
          _task(runState: 'error', todoIgnored: true, manualTodo: true),
        ),
        AirTaskAction.unignore,
      );
      // 手动标记压过状态动作。
      expect(
        airTaskPrimaryAction(_task(runState: 'waiting', manualTodo: true)),
        AirTaskAction.unmarkTodo,
      );
      expect(
        airTaskPrimaryAction(_task(runState: 'error')),
        AirTaskAction.ignoreError,
      );
      expect(
        airTaskPrimaryAction(_task(runState: 'waiting')),
        AirTaskAction.ignoreWaiting,
      );
      expect(
        airTaskPrimaryAction(
          _task(runState: 'succeeded', goalState: 'interact'),
        ),
        AirTaskAction.markAchieved,
      );
      expect(airTaskPrimaryAction(_task(runState: 'idle')), AirTaskAction.markTodo);
      expect(
        airTaskPrimaryAction(_task(runState: 'succeeded', goalState: 'achieved')),
        AirTaskAction.markTodo,
      );
    });

    test('每个动作都有中英文案键', () {
      for (final action in AirTaskAction.values) {
        expect(t(action.labelKey), isNotEmpty);
        expect(t(action.labelKey), isNot(action.labelKey));
      }
      expect(t('airNeedsMeFilter'), '等我处理');
      expect(t('airTodoIgnoreError'), '忽略异常');
      expect(t('airTodoIgnoreWaiting'), '忽略等待');
      expect(t('airTodoMarkAchieved'), '标记达成');
      expect(t('airTodoMarkAchievedDone'), '已标记为达成目标');
      expect(t('airTodoIgnoredBadge'), '已忽略');
      expect(t('airTodoErrNotApplicable'), '当前状态下不能执行这个操作');
    });

    test('标记达成后任务离开等我处理（乐观更新替换同一行）', () {
      final snapshot = AirSnapshot.fromJson(const {
        'directories': [],
        'tasks': [
          {
            'id': 't1',
            'dirId': 'd1',
            'title': 'a',
            'status': 'active',
            'runState': 'succeeded',
            'goalState': 'interact',
          },
        ],
      });
      expect(airNeedsMeTasks(snapshot.tasks), hasLength(1));
      final updated = snapshot.withTask(
        snapshot.tasks.single.copyWith(goalState: 'achieved'),
      );
      expect(updated.tasks.single.goalState, 'achieved');
      expect(airNeedsMeTasks(updated.tasks), isEmpty);
    });
  });
}
