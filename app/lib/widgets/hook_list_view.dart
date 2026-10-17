import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/event_trigger_service.dart';
import '../services/air_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 「注入到」里代表“每次触发新建一个会话”的哨兵值（与网页 hook-editor.js 一致）。
const String kHookNewSession = '__new__';

/// 「触发器任务」列表 + 新建/编辑底部弹层 — 定时任务页的第二个 tab，镜像网页
/// air-trigger-center.js。规则 = 「当 [事件…] 发生时 → 执行 [动作]」，全局规则
/// 与各会话的规则放在同一张表里。
///
/// 带 [sessionId] 时只列这个会话的规则，新建默认挂在它上面 —— 对话页头 ⋯ 里的
/// 「钩子」（同网页 chat-hooks.js 的 🪝 按钮）。
class HookListView extends StatefulWidget {
  final SettingsService settings;
  final EventTriggerService? service; // 测试注入
  final String? sessionId;
  const HookListView({
    super.key,
    required this.settings,
    this.service,
    this.sessionId,
  });

  @override
  State<HookListView> createState() => HookListViewState();
}

class HookListViewState extends State<HookListView> {
  late final EventTriggerService _svc =
      widget.service ?? EventTriggerService(settings: widget.settings);

  List<HookItem> _items = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    refresh();
  }

  Future<void> refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final all = await _svc.fetchAll();
      final only = widget.sessionId;
      final items = only == null
          ? all
          : all.where((item) => item.sessionId == only).toList();
      if (!mounted) return;
      setState(() {
        _items = items;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _act(String failLabel, Future<void> Function() work) async {
    try {
      await work();
      await refresh();
    } catch (e) {
      _snack('$failLabel：$e');
    }
  }

  Future<void> _test(HookItem item) async {
    final target = item.isGlobal ? '全局' : (item.sessionLabel ?? item.sessionId);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发送测试事件'),
        content: Text('将对「$target」发出一个模拟事件，可能真的触发通知、Webhook 或向会话注入指令。继续？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('继续'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _svc.test(item);
      _snack('已发出测试事件，稍后下拉刷新可看到结果');
    } catch (e) {
      _snack('测试失败：$e');
    }
  }

  Future<void> _delete(HookItem item) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除触发器'),
        content: const Text('删除这条触发器？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除', style: TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
    if (ok == true) await _act('删除失败', () => _svc.remove(item));
  }

  /// 外部（FAB）调用：新建；[item] 非空 = 编辑。
  Future<void> openEditor({HookItem? item}) async {
    final air = AirService(settings: widget.settings);
    // 会话与工作区来自同一份 Air 快照；快照或 CLI 清单取不到都只是少几个选项，不阻塞编辑器。
    final results = await Future.wait([
      air.load().then<AirSnapshot?>((v) => v, onError: (_) => null),
      _svc.fetchClis(),
    ]);
    air.close();
    final snapshot = results[0] as AirSnapshot?;
    final sessions = snapshot == null
        ? <HookChoice>[]
        : hookSessionChoices(snapshot);
    final dirs = snapshot == null
        ? <HookChoice>[]
        : [for (final d in snapshot.directories) (id: d.id, label: d.name)];
    if (!mounted) return;
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) => HookEditor(
        service: _svc,
        item: item,
        sessions: sessions,
        dirs: dirs,
        clis: results[1] as List<String>,
        initialScopeSession: widget.sessionId ?? '',
      ),
    );
    if (saved == true) await refresh();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.accent),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.danger, fontSize: 13),
              ),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: refresh, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    return RefreshIndicator(
      color: AppColors.accent,
      backgroundColor: AppColors.panel,
      onRefresh: refresh,
      child: _items.isEmpty
          ? ListView(
              children: [
                SizedBox(height: widget.sessionId == null ? 120 : 40),
                const Icon(
                  Icons.webhook_outlined,
                  size: 44,
                  color: AppColors.faint,
                ),
                const SizedBox(height: 12),
                const Center(
                  child: Text(
                    '还没有触发器',
                    style: TextStyle(
                      color: AppColors.textBright,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 32),
                  child: Text(
                    widget.sessionId == null
                        ? '点右下角「新建」，任务完成、出错等事件发生时自动通知、发 Webhook 或给会话注入指令。'
                        : '本会话还没有钩子。点「新建钩子」，任务完成、出错等事件发生时自动通知、发 Webhook 或注入指令。',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 12.5,
                    ),
                  ),
                ),
              ],
            )
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
              itemCount: _items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) => HookCard(
                item: _items[i],
                onToggle: () => _act(
                  '更新失败',
                  () => _svc.setEnabled(_items[i], !_items[i].rule.enabled),
                ),
                onTest: () => _test(_items[i]),
                onEdit: () => openEditor(item: _items[i]),
                onDelete: () => _delete(_items[i]),
              ),
            ),
    );
  }
}

String _fmtRun(int? ms) {
  if (ms == null) return '—';
  final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${d.month}/${d.day} ${two(d.hour)}:${two(d.minute)}';
}

class HookCard extends StatelessWidget {
  final HookItem item;
  final VoidCallback onToggle;
  final VoidCallback onTest;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  const HookCard({
    super.key,
    required this.item,
    required this.onToggle,
    required this.onTest,
    required this.onEdit,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final rule = item.rule;
    final run = item.lastRun;
    final title = rule.name.isNotEmpty
        ? rule.name
        : rule.on.map(hookEventLabel).join(' / ');
    final owner = item.isGlobal
        ? '全局'
        : '会话：${item.sessionLabel ?? item.sessionId}';
    final runText = run == null
        ? '尚未触发'
        : '最近执行 ${_fmtRun(run.ts)}${run.steps != null ? ' · ${run.step}/${run.steps}' : ''} · ${run.ok ? '成功' : '失败 ${run.error}'}';
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(
          color: rule.enabled
              ? AppColors.line
              : AppColors.line.withValues(alpha: 0.5),
        ),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    color: rule.enabled
                        ? AppColors.textBright
                        : AppColors.muted,
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Switch(value: rule.enabled, onChanged: (_) => onToggle()),
            ],
          ),
          Text(
            '${rule.on.map(hookEventLabel).join(' · ')}  →  ${hookActionLabel(rule.kind)}',
            style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
          ),
          if (rule.kind == 'inject-prompt') ...[
            const SizedBox(height: 4),
            Text(
              rule.newSession != null
                  ? '注入到：新建会话'
                  : ((rule.action['targetSessionId'] ?? '').toString().isEmpty
                        ? '注入到：触发事件的会话'
                        : '注入到：会话 ${rule.action['targetSessionId']}'),
              style: const TextStyle(color: AppColors.faint, fontSize: 12),
            ),
          ],
          if (rule.kind == 'inject-prompt' &&
              (rule.action['prompt'] ?? '').toString().isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              rule.action['prompt'].toString(),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AppColors.faint, fontSize: 12),
            ),
          ],
          // 链式钩子：标出总步数，后续步骤按序号列在第一步下面（同网页）。
          if (rule.then.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              '共 ${rule.then.length + 1} 步',
              style: const TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            for (var i = 0; i < rule.then.length; i++)
              Text(
                '${i + 2}. ${(rule.then[i]['prompt'] ?? '').toString().isNotEmpty ? rule.then[i]['prompt'] : hookActionLabel((rule.then[i]['kind'] ?? '').toString())}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.faint, fontSize: 12),
              ),
          ],
          const SizedBox(height: 8),
          Row(
            children: [
              Icon(
                Icons.circle,
                size: 8,
                color: run == null
                    ? AppColors.faint
                    : (run.ok ? AppColors.codex : AppColors.danger),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '$owner · $runText',
                  style: const TextStyle(color: AppColors.faint, fontSize: 11),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const Divider(height: 18, color: AppColors.line),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(
                onPressed: onTest,
                icon: const Icon(
                  Icons.play_arrow_rounded,
                  size: 18,
                  color: AppColors.accent,
                ),
                label: const Text(
                  '测试',
                  style: TextStyle(color: AppColors.accent, fontSize: 13),
                ),
              ),
              TextButton.icon(
                onPressed: onEdit,
                icon: const Icon(
                  Icons.edit_outlined,
                  size: 17,
                  color: AppColors.blue,
                ),
                label: const Text(
                  '编辑',
                  style: TextStyle(color: AppColors.blue, fontSize: 13),
                ),
              ),
              IconButton(
                onPressed: onDelete,
                icon: const Icon(
                  Icons.delete_outline_rounded,
                  size: 19,
                  color: AppColors.danger,
                ),
                tooltip: '删除',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 新建/编辑触发器的底部弹层。
class HookEditor extends StatefulWidget {
  final EventTriggerService service;
  final HookItem? item;
  final List<({String id, String label})> sessions;
  final List<({String id, String label})> dirs;
  final List<String> clis;

  /// 新建时「作用范围」默认选哪个会话；'' = 全局。
  final String initialScopeSession;
  const HookEditor({
    super.key,
    required this.service,
    this.item,
    this.sessions = const [],
    this.dirs = const [],
    this.clis = const [],
    this.initialScopeSession = '',
  });

  @override
  State<HookEditor> createState() => _HookEditorState();
}

class _HookEditorState extends State<HookEditor> {
  late final TextEditingController _name;
  late final TextEditingController _message;
  late final TextEditingController _url;
  late final TextEditingController _prompt;
  late final TextEditingController _cooldown;
  late final Set<String> _on;
  late String _kind;
  late bool _enabled;
  late bool _skipCancelled;
  late bool _includeConclusion;
  String _scopeSession = ''; // '' = 全局（仅新建）
  String _target = ''; // '' = 触发事件的会话；kHookNewSession = 新建；否则是会话 id
  String _newDir = '';
  String _newCli = '';
  late final TextEditingController _newTitle;

  /// 后续步骤：可编辑的注入指令带一个输入框；其余（经 API 建的通知 / Webhook /
  /// 指定目标）原样保留、只能删除。
  final List<({Map<String, dynamic> step, TextEditingController? prompt})>
  _chain = [];
  bool _saving = false;
  String? _err;

  HookItem? get _editing => widget.item;

  @override
  void initState() {
    super.initState();
    final r = _editing?.rule;
    _scopeSession = widget.initialScopeSession;
    _name = TextEditingController(text: r?.name ?? '');
    _message = TextEditingController(
      text: (r?.action['message'] ?? '').toString(),
    );
    _url = TextEditingController(text: (r?.action['url'] ?? '').toString());
    _prompt = TextEditingController(
      text: (r?.action['prompt'] ?? '').toString(),
    );
    _cooldown = TextEditingController(
      text: r != null && r.cooldownMs > 0 ? '${r.cooldownMs ~/ 1000}' : '',
    );
    _on = {...?r?.on};
    _kind = r?.kind.isNotEmpty == true ? r!.kind : 'notify';
    _enabled = r?.enabled ?? true;
    _skipCancelled = r?.skipCancelled ?? false;
    _includeConclusion = r?.action['includeConclusion'] == true;
    _target = (r?.action['targetSessionId'] ?? '').toString();
    final spec = r?.newSession;
    if (spec != null) _target = kHookNewSession;
    _newDir = spec?.dirId ?? '';
    _newCli = spec?.cli ?? '';
    _newTitle = TextEditingController(text: spec?.title ?? '');
    for (final step in r?.then ?? const <Map<String, dynamic>>[]) {
      _addStep(step);
    }
  }

  void _addStep(Map<String, dynamic> step) => _chain.add((
    step: step,
    prompt: hookChainStepEditable(step)
        ? TextEditingController(text: (step['prompt'] ?? '').toString())
        : null,
  ));

  @override
  void dispose() {
    for (final c in [
      _name,
      _message,
      _url,
      _prompt,
      _cooldown,
      _newTitle,
      for (final entry in _chain)
        if (entry.prompt != null) entry.prompt!,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  HookDraft _draft() => HookDraft(
    name: _name.text,
    on: [
      // 保持目录里的事件顺序，保存结果稳定。
      for (final (value, _) in kHookEvents)
        if (_on.contains(value)) value,
      // 编辑时保留目录里没有的自定义模式（例如 task.*）。
      for (final v in _on)
        if (!kHookEvents.any((e) => e.$1 == v)) v,
    ],
    skipCancelled: _skipCancelled,
    kind: _kind,
    message: _message.text,
    url: _url.text,
    secretName: (_editing?.rule.action['secretName'] ?? '').toString(),
    includeConclusion: _includeConclusion,
    prompt: _prompt.text,
    targetSessionId: _target == kHookNewSession ? '' : _target,
    newSession: _target == kHookNewSession
        ? HookNewSession(dirId: _newDir, cli: _newCli, title: _newTitle.text)
        : null,
    then: [
      for (final entry in _chain)
        entry.prompt == null
            ? entry.step
            : {'kind': 'inject-prompt', 'prompt': entry.prompt!.text.trim()},
    ],
    cooldownSeconds: int.tryParse(_cooldown.text.trim()) ?? 0,
    enabled: _enabled,
    baseFilter: _editing?.rule.filter ?? const {},
  );

  Future<void> _save() async {
    final draft = _draft();
    final bad = draft.validate();
    if (bad != null) return setState(() => _err = bad);
    setState(() {
      _saving = true;
      _err = null;
    });
    try {
      if (_editing != null) {
        await widget.service.update(_editing!, draft);
      } else {
        await widget.service.create(draft, sessionId: _scopeSession);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _err = '保存失败：$e';
          _saving = false;
        });
      }
    }
  }

  Widget _label(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(
      text,
      style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
    ),
  );

  InputDecoration _deco(String hint) => InputDecoration(
    hintText: hint,
    isDense: true,
    filled: true,
    fillColor: AppColors.panel2,
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: const BorderSide(color: AppColors.line),
    ),
  );

  Widget _dropdown({
    required String value,
    required List<DropdownMenuItem<String>> items,
    required ValueChanged<String> onChanged,
  }) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12),
    decoration: BoxDecoration(
      color: AppColors.panel2,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: AppColors.line),
    ),
    child: DropdownButtonHideUnderline(
      child: DropdownButton<String>(
        value: value,
        isExpanded: true,
        dropdownColor: AppColors.panel2,
        items: items,
        onChanged: (v) => onChanged(v ?? value),
      ),
    ),
  );

  /// 会话很多时用的选择器：点一下弹出带搜索框的列表，按标题或工作区名过滤。
  Widget _choiceField({
    required String title,
    required String value,
    required List<HookChoice> pinned,
    required List<HookChoice> choices,
    required ValueChanged<String> onChanged,
  }) {
    final all = [...pinned, ...choices];
    final current = all.where((c) => c.id == value);
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () async {
        final picked = await showHookChoicePicker(
          context,
          title: title,
          pinned: pinned,
          choices: choices,
          selected: value,
        );
        if (picked != null) onChanged(picked);
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.panel2,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.line),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                current.isEmpty ? value : current.first.label,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const Icon(Icons.search_rounded, size: 18, color: AppColors.faint),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    // 作用范围 / 注入目标的会话选项。编辑时目标会话可能已被删除：把它的 id 当选项保留，
    // 免得静默改成“触发事件的会话”（与网页一致）。
    final sessionChoices = <HookChoice>[...widget.sessions];
    if (_target.isNotEmpty &&
        _target != kHookNewSession &&
        !sessionChoices.any((c) => c.id == _target)) {
      sessionChoices.add((id: _target, label: _target));
    }
    if (_scopeSession.isNotEmpty &&
        !sessionChoices.any((c) => c.id == _scopeSession)) {
      sessionChoices.add((id: _scopeSession, label: _scopeSession));
    }
    // 工作区 / CLI 在列表里找不到（已删除、后端版本较旧）时回退到“沿用”，免得 Dropdown 断言。
    final dirValue = widget.dirs.any((d) => d.id == _newDir) ? _newDir : '';
    final cliValue = widget.clis.contains(_newCli) ? _newCli : '';
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 14, 16, 16 + bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(
                  color: AppColors.line,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Text(
              _editing == null ? '新建触发器' : '编辑触发器',
              style: const TextStyle(
                color: AppColors.textBright,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 16),
            if (_editing == null) ...[
              _label('作用范围'),
              _choiceField(
                title: '作用范围',
                value: _scopeSession,
                pinned: const [(id: '', label: '全局（所有会话）')],
                choices: sessionChoices,
                onChanged: (v) => setState(() => _scopeSession = v),
              ),
              const SizedBox(height: 14),
            ],
            _label('名称（可选）'),
            TextField(controller: _name, maxLength: 80, decoration: _deco('')),
            _label('当发生以下事件时'),
            for (final (value, text) in kHookEvents)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _on.contains(value),
                title: Text(text, style: const TextStyle(fontSize: 13)),
                onChanged: (v) => setState(() {
                  v == true ? _on.add(value) : _on.remove(value);
                }),
              ),
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _skipCancelled,
              title: const Text('不含我主动停止的', style: TextStyle(fontSize: 13)),
              onChanged: (v) => setState(() => _skipCancelled = v == true),
            ),
            const SizedBox(height: 10),
            _label('就执行'),
            _dropdown(
              value: _kind,
              items: [
                for (final (value, text) in kHookActions)
                  DropdownMenuItem(value: value, child: Text(text)),
              ],
              onChanged: (v) => setState(() => _kind = v),
            ),
            const SizedBox(height: 14),
            if (_kind == 'notify') ...[
              _label('通知内容（可选）'),
              TextField(
                controller: _message,
                maxLength: 400,
                decoration: _deco(''),
              ),
            ] else if (_kind == 'webhook') ...[
              _label('Webhook 地址'),
              TextField(
                controller: _url,
                keyboardType: TextInputType.url,
                decoration: _deco('https://'),
              ),
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _includeConclusion,
                title: const Text(
                  '附带最后一轮结论与摘要（会发送到外部，请确认）',
                  style: TextStyle(fontSize: 13),
                ),
                onChanged: (v) =>
                    setState(() => _includeConclusion = v == true),
              ),
            ] else ...[
              _label('注入到'),
              _choiceField(
                title: '注入到',
                value: _target,
                pinned: const [
                  (id: '', label: '触发事件的会话'),
                  (id: kHookNewSession, label: '新建会话（每次触发新建一个）'),
                ],
                choices: sessionChoices,
                onChanged: (v) => setState(() => _target = v),
              ),
              if (_target == kHookNewSession) ...[
                const SizedBox(height: 14),
                _label('新会话所在工作区'),
                _dropdown(
                  value: dirValue,
                  items: [
                    const DropdownMenuItem(
                      value: '',
                      child: Text('触发事件所在的工作区'),
                    ),
                    for (final d in widget.dirs)
                      DropdownMenuItem(
                        value: d.id,
                        child: Text(d.label, overflow: TextOverflow.ellipsis),
                      ),
                  ],
                  onChanged: (v) => setState(() => _newDir = v),
                ),
                const SizedBox(height: 14),
                _label('新会话使用的 CLI'),
                _dropdown(
                  value: cliValue,
                  items: [
                    const DropdownMenuItem(
                      value: '',
                      child: Text('与触发事件的会话相同'),
                    ),
                    for (final c in widget.clis)
                      DropdownMenuItem(value: c, child: Text(c)),
                  ],
                  onChanged: (v) => setState(() => _newCli = v),
                ),
                const SizedBox(height: 14),
                _label('新会话标题（可选，默认用规则名称）'),
                TextField(
                  controller: _newTitle,
                  maxLength: 120,
                  decoration: _deco(''),
                ),
              ],
              const SizedBox(height: 14),
              _label('你的指令'),
              TextField(
                controller: _prompt,
                minLines: 3,
                maxLines: 6,
                maxLength: 4000,
                decoration: _deco('例如：把结论整理成发布说明'),
              ),
              const Text(
                '系统会自动附上来源会话、任务目标、状态和上一轮结论，你只需写指令。',
                style: TextStyle(color: AppColors.faint, fontSize: 11.5),
              ),
            ],
            const SizedBox(height: 14),
            _label('然后依次执行（可选）'),
            for (var i = 0; i < _chain.length; i++)
              Padding(
                key: ValueKey('hook-chain-step-$i'),
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 10, right: 6),
                      child: Text(
                        '${i + 2}.',
                        style: const TextStyle(color: AppColors.muted),
                      ),
                    ),
                    Expanded(
                      child: _chain[i].prompt != null
                          ? TextField(
                              controller: _chain[i].prompt,
                              minLines: 1,
                              maxLines: 4,
                              maxLength: 4000,
                              decoration: _deco('第 ${i + 2} 步的指令'),
                            )
                          : Padding(
                              padding: const EdgeInsets.only(top: 10),
                              child: Text(
                                '${hookActionLabel((_chain[i].step['kind'] ?? '').toString())}（保留原设置）',
                                style: const TextStyle(fontSize: 13),
                              ),
                            ),
                    ),
                    IconButton(
                      tooltip: '删除这一步',
                      icon: const Icon(
                        Icons.close_rounded,
                        size: 18,
                        color: AppColors.danger,
                      ),
                      onPressed: () => setState(() {
                        _chain.removeAt(i).prompt?.dispose();
                      }),
                    ),
                  ],
                ),
              ),
            if (_chain.length < kHookMaxChainSteps)
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  key: const ValueKey('hook-chain-add'),
                  onPressed: () => setState(
                    () => _addStep({'kind': 'inject-prompt', 'prompt': ''}),
                  ),
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('添加下一步'),
                ),
              ),
            const Text(
              '每一步都等上一步注入的那一轮跑完（任务完成）才开始，接在上一步所在的会话里，并自动带上上一步的结论；某一步失败或停下等你回复时，后面的步骤不再执行。',
              style: TextStyle(color: AppColors.faint, fontSize: 11.5),
            ),
            const SizedBox(height: 14),
            _label('冷却（秒，留空用默认）'),
            TextField(
              controller: _cooldown,
              keyboardType: TextInputType.number,
              decoration: _deco(''),
            ),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _enabled,
              title: const Text('启用', style: TextStyle(fontSize: 13)),
              onChanged: (v) => setState(() => _enabled = v),
            ),
            if (_err != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  _err!,
                  style: const TextStyle(color: AppColors.danger, fontSize: 12),
                ),
              ),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _saving ? null : () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? '保存中…' : '保存'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 过滤：固定项永远保留；会话按标题或工作区名做不区分大小写的子串匹配，当前选中项
/// 即使不匹配也保留（与网页 hook-editor.js 一致）。
List<HookChoice> filterHookChoices(
  List<HookChoice> choices,
  String query, {
  String selected = '',
}) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return choices;
  return [
    for (final c in choices)
      if (c.id == selected || c.label.toLowerCase().contains(q)) c,
  ];
}

/// 弹出搜索选择器；返回选中的 id，取消返回 null。
Future<String?> showHookChoicePicker(
  BuildContext context, {
  required String title,
  required List<HookChoice> pinned,
  required List<HookChoice> choices,
  required String selected,
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => _HookChoicePicker(
      title: title,
      pinned: pinned,
      choices: choices,
      selected: selected,
    ),
  );
}

class _HookChoicePicker extends StatefulWidget {
  final String title;
  final List<HookChoice> pinned;
  final List<HookChoice> choices;
  final String selected;
  const _HookChoicePicker({
    required this.title,
    required this.pinned,
    required this.choices,
    required this.selected,
  });

  @override
  State<_HookChoicePicker> createState() => _HookChoicePickerState();
}

class _HookChoicePickerState extends State<_HookChoicePicker> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    final matched = filterHookChoices(
      widget.choices,
      _query,
      selected: widget.selected,
    );
    final rows = [...widget.pinned, ...matched];
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    widget.title,
                    style: const TextStyle(
                      color: AppColors.textBright,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    autofocus: false,
                    onChanged: (v) => setState(() => _query = v),
                    decoration: InputDecoration(
                      hintText: '搜索会话（标题或工作区名）',
                      prefixIcon: const Icon(Icons.search_rounded, size: 20),
                      isDense: true,
                      filled: true,
                      fillColor: AppColors.panel2,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(10),
                        borderSide: const BorderSide(color: AppColors.line),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView.builder(
                itemCount: rows.length,
                itemBuilder: (_, i) {
                  final c = rows[i];
                  final on = c.id == widget.selected;
                  return ListTile(
                    dense: true,
                    title: Text(
                      c.label,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    trailing: on
                        ? const Icon(
                            Icons.check_rounded,
                            size: 18,
                            color: AppColors.accent,
                          )
                        : null,
                    onTap: () => Navigator.pop(context, c.id),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 对话页头 ⋯ →「钩子」：本会话的「事件 → 动作」规则，可就地新建 / 编辑 / 启停 /
/// 删除（同网页 chat-hooks.js）。全部规则仍在「定时任务 → 触发器任务」里。
Future<void> showSessionHooksSheet(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
  EventTriggerService? service,
}) {
  final list = GlobalKey<HookListViewState>();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    backgroundColor: AppColors.bg,
    builder: (sheetContext) => SizedBox(
      key: const ValueKey('session-hooks-sheet'),
      height: MediaQuery.sizeOf(sheetContext).height * .7,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 12, 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    t('hookTitle'),
                    style: const TextStyle(
                      color: AppColors.textBright,
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                FilledButton.icon(
                  key: const ValueKey('session-hooks-new'),
                  onPressed: () => list.currentState?.openEditor(),
                  icon: const Icon(Icons.add, size: 18),
                  label: Text(t('hookDialogNew')),
                ),
              ],
            ),
          ),
          Expanded(
            child: HookListView(
              key: list,
              settings: settings,
              service: service,
              sessionId: sessionId,
            ),
          ),
        ],
      ),
    ),
  );
}
