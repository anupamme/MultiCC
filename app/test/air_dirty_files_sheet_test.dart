import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/git_commit.dart';
import 'package:multicc_app/widgets/air/air_dirty_files_sheet.dart';

/// 「未提交文件」面板：清单 → 单个文件的改动。取数函数全部注入，不碰网络。
/// 钉四件事：清单按状态+路径列出且首个文件名完整（服务端曾把首字母吃掉）；
/// 点文件进它的改动页并请求「这个文件」的路径；没有可显示的改动照实说；
/// 取数失败按错误页画，不当成空清单。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  Widget host({
    required Future<List<GitDirtyFile>> Function() fetchFiles,
    required Future<GitWorkingDiff> Function(String path) fetchDiff,
  }) => MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: ElevatedButton(
            onPressed: () => showAirDirtyFilesSheet(
              context,
              fetchFiles: fetchFiles,
              fetchDiff: fetchDiff,
            ),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );

  Future<List<GitDirtyFile>> files() async => const [
    GitDirtyFile(status: 'M', path: 'air-todos.json'),
    GitDirtyFile(status: '??', path: 'notes/scratch.md'),
    GitDirtyFile(status: 'R', path: 'old.txt → renamed.txt'),
  ];

  testWidgets('列出状态与完整路径，标题带数量', (tester) async {
    await tester.pumpWidget(
      host(
        fetchFiles: files,
        fetchDiff: (_) async => const GitWorkingDiff(
          path: '',
          patch: '',
          truncated: false,
          untracked: false,
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('● 3 个未提交文件（主检出）'), findsOneWidget);
    expect(find.text('air-todos.json'), findsOneWidget);
    expect(find.text('notes/scratch.md'), findsOneWidget);
    expect(find.text('??'), findsOneWidget);
  });

  testWidgets('点文件进改动页；重命名按新路径请求；patch 原样显示', (tester) async {
    final asked = <String>[];
    await tester.pumpWidget(
      host(
        fetchFiles: files,
        fetchDiff: (path) async {
          asked.add(path);
          return GitWorkingDiff(
            path: path,
            patch: 'diff --git a/x b/x\n@@ -1 +1 @@\n-旧\n+新内容',
            truncated: false,
            untracked: false,
          );
        },
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-dirty-file-0')));
    await tester.pumpAndSettle();
    expect(asked, ['air-todos.json']);
    expect(find.textContaining('+新内容', findRichText: true), findsOneWidget);

    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-dirty-file-2')));
    await tester.pumpAndSettle();
    expect(asked.last, 'renamed.txt');
  });

  testWidgets('没有可显示的改动时照实说，不画空白', (tester) async {
    await tester.pumpWidget(
      host(
        fetchFiles: files,
        fetchDiff: (path) async => GitWorkingDiff(
          path: path,
          patch: '',
          truncated: false,
          untracked: false,
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-dirty-file-0')));
    await tester.pumpAndSettle();
    expect(find.text('在工作区里没有可显示的改动（可能已被提交或还原）'), findsOneWidget);
  });

  testWidgets('取清单失败按错误页画；清单为空说主检出干净', (tester) async {
    await tester.pumpWidget(
      host(
        fetchFiles: () async => throw Exception('boom'),
        fetchDiff: (_) async => throw StateError('unused'),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.textContaining('读取 Git 状态失败'), findsOneWidget);
    expect(find.textContaining('boom'), findsOneWidget);

    Navigator.of(tester.element(find.byType(Scaffold).first)).pop();
    await tester.pumpAndSettle();
    await tester.pumpWidget(
      host(
        fetchFiles: () async => const <GitDirtyFile>[],
        fetchDiff: (_) async => throw StateError('unused'),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('主检出工作区干净'), findsOneWidget);
  });
}
