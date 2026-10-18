import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/task_directory_hint.dart';

Map<String, dynamic> decision({
  String id = 'dec_1',
  String fromTaskId = 'tsk_from',
  String? toTaskId,
  String path = 'none',
  String state = 'pending',
  String dirId = 'dir_target',
  String reason = '这段对话一直在改目标目录的代码',
  bool hidden = false,
  bool withHint = true,
}) => {
  'id': id,
  'fromTaskId': fromTaskId,
  'toTaskId': toTaskId,
  'path': path,
  'state': state,
  'hidden': hidden,
  'directoryHint': withHint ? {'dirId': dirId, 'reason': reason} : null,
};

void main() {
  group('parseTaskDirectoryHint', () {
    test('reads the hint contract and normalizes empty targets', () {
      final parsed = parseTaskDirectoryHint(
        decision(toTaskId: 'tsk_to', path: 'identity'),
      );
      expect(parsed, isNotNull);
      expect(parsed!.decisionId, 'dec_1');
      expect(parsed.fromTaskId, 'tsk_from');
      expect(parsed.toTaskId, 'tsk_to');
      expect(parsed.targetTaskId, 'tsk_to');
      expect(parsed.dirId, 'dir_target');
      expect(parsed.reason, '这段对话一直在改目标目录的代码');
      expect(parsed.needsAccept, isTrue);
    });

    test('pure hints have no target and never accept', () {
      final parsed = parseTaskDirectoryHint(decision())!;
      expect(parsed.toTaskId, isNull);
      expect(parsed.targetTaskId, 'tsk_from');
      expect(parsed.needsAccept, isFalse);
    });

    test('overlay rows relocate but do not accept', () {
      final parsed = parseTaskDirectoryHint(
        decision(toTaskId: 'tsk_to', path: 'overlay'),
      )!;
      expect(parsed.targetTaskId, 'tsk_to');
      expect(parsed.needsAccept, isFalse);
    });

    test('rejects malformed or hidden rows', () {
      expect(parseTaskDirectoryHint(null), isNull);
      expect(parseTaskDirectoryHint(const <String, dynamic>{}), isNull);
      expect(parseTaskDirectoryHint(decision(withHint: false)), isNull);
      expect(parseTaskDirectoryHint(decision(hidden: true)), isNull);
      expect(parseTaskDirectoryHint(decision(reason: '   ')), isNull);
      expect(parseTaskDirectoryHint(decision(dirId: '')), isNull);
      expect(parseTaskDirectoryHint(decision(fromTaskId: '')), isNull);
      expect(parseTaskDirectoryHint(decision(id: '')), isNull);
    });
  });

  group('taskDirectoryHintsFromDecisions', () {
    test('keeps only open states', () {
      final hints = taskDirectoryHintsFromDecisions([
        decision(id: 'dec_pending'),
        decision(
          id: 'dec_deferred',
          state: 'deferred',
          fromTaskId: 'tsk_deferred',
        ),
        decision(id: 'dec_applied', state: 'applied'),
        decision(id: 'dec_queued', state: 'queued'),
        decision(id: 'dec_dismissed', state: 'dismissed'),
      ]);
      expect(hints.map((hint) => hint.decisionId), [
        'dec_pending',
        'dec_deferred',
      ]);
    });

    test('dedupes repeated rows and one task/directory pair', () {
      final hints = taskDirectoryHintsFromDecisions([
        decision(id: 'dec_a'),
        decision(id: 'dec_a'),
        decision(id: 'dec_b'),
        decision(id: 'dec_c', fromTaskId: 'other', dirId: 'dir_other'),
      ]);
      // dec_a 重复两次只算一次；dec_b 与 dec_a 是同一任务+目录，也收掉。
      expect(hints.map((hint) => hint.decisionId), ['dec_a', 'dec_c']);
    });

    test('local decisions win over a stale server list', () {
      final hints = taskDirectoryHintsFromDecisions(
        [decision(id: 'dec_a'), decision(id: 'dec_b')],
        resolved: {'dec_a'},
      );
      expect(hints.map((hint) => hint.decisionId), ['dec_b']);
    });

    test('non-list payload yields no cards', () {
      expect(taskDirectoryHintsFromDecisions(null), isEmpty);
      expect(taskDirectoryHintsFromDecisions('nope'), isEmpty);
    });
  });

  group('directoryHintErrorKey', () {
    test('maps every actionable relocate refusal', () {
      expect(directoryHintErrorKey('task_busy'), 'taskDirectoryHintBusy');
      expect(
        directoryHintErrorKey('task_archived'),
        'taskDirectoryHintArchived',
      );
      expect(
        directoryHintErrorKey('task_shell_shared'),
        'taskDirectoryHintShared',
      );
      expect(
        directoryHintErrorKey('target directory not found'),
        'taskDirectoryHintTargetMissing',
      );
      expect(
        directoryHintErrorKey('task_deleting'),
        'taskDirectoryHintDeleting',
      );
    });

    test('unknown codes fall through to the generic failure copy', () {
      expect(directoryHintErrorKey('task_relocate_failed'), isNull);
      expect(directoryHintErrorKey(''), isNull);
    });
  });
}
