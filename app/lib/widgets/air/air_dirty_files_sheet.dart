// 主检出「未提交文件」底部面板：列出脏文件，点一个就进它的改动（工作区对 HEAD 的
// diff，未跟踪文件按整份新增显示）。是 Web 目录页「点文件名看改动」的移动端对应物。
// 数据走 /api/git/directory-status 与 /api/git/directory-file-diff，取数函数从外部
// 注入，widget 测试无需真实网络。
import 'package:flutter/material.dart';

import '../../i18n.dart';
import '../../models/git_commit.dart';
import '../session_diff_dialog.dart' show diffSpans;

Future<void> showAirDirtyFilesSheet(
  BuildContext context, {
  required Future<List<GitDirtyFile>> Function() fetchFiles,
  required Future<GitWorkingDiff> Function(String path) fetchDiff,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: const Color(0xFFffffff),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => _DirtyFilesSheet(fetchFiles: fetchFiles, fetchDiff: fetchDiff),
  );
}

class _DirtyFilesSheet extends StatefulWidget {
  const _DirtyFilesSheet({required this.fetchFiles, required this.fetchDiff});

  final Future<List<GitDirtyFile>> Function() fetchFiles;
  final Future<GitWorkingDiff> Function(String path) fetchDiff;

  @override
  State<_DirtyFilesSheet> createState() => _DirtyFilesSheetState();
}

class _DirtyFilesSheetState extends State<_DirtyFilesSheet> {
  List<GitDirtyFile>? _files;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _files = null;
      _error = null;
    });
    try {
      final files = await widget.fetchFiles();
      if (mounted) setState(() => _files = files);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final files = _files;
    return SizedBox(
      height: MediaQuery.of(context).size.height * 0.82,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
            child: Row(
              children: [
                const Icon(
                  Icons.edit_note_rounded,
                  size: 18,
                  color: Color(0xFFa85a25),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    t('airGitDirtyFiles', {'n': '${files?.length ?? 0}'}),
                    style: const TextStyle(
                      color: Color(0xFF20364d),
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                IconButton(
                  icon: const Icon(
                    Icons.refresh_rounded,
                    size: 18,
                    color: Color(0xFF6f8096),
                  ),
                  tooltip: t('retry'),
                  onPressed: _load,
                ),
              ],
            ),
          ),
          Expanded(child: _body(files)),
        ],
      ),
    );
  }

  Widget _body(List<GitDirtyFile>? files) {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            t('airGitStatusFailed', {'msg': _error!}),
            style: const TextStyle(color: Color(0xFFb64e43), fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    if (files == null) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (files.isEmpty) {
      return Center(
        child: Text(
          t('airGitMainClean'),
          style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 13),
        ),
      );
    }
    return ListView.separated(
      itemCount: files.length,
      separatorBuilder: (_, __) =>
          const Divider(height: 1, color: Color(0xFFf8fbff)),
      itemBuilder: (context, index) {
        final file = files[index];
        return ListTile(
          key: ValueKey('air-dirty-file-$index'),
          dense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
          leading: SizedBox(
            width: 28,
            child: Text(
              file.status.isEmpty ? 'M' : file.status,
              style: const TextStyle(
                color: Color(0xFF218468),
                fontFamily: 'monospace',
              ),
            ),
          ),
          title: Text(
            file.path,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: Color(0xFF233249), fontSize: 13),
          ),
          trailing: const Icon(
            Icons.chevron_right_rounded,
            size: 18,
            color: Color(0xFF8a9aab),
          ),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) =>
                  _DirtyFileDiffPage(file: file, fetchDiff: widget.fetchDiff),
            ),
          ),
        );
      },
    );
  }
}

/// 第二层：一个文件的改动。不把全部文件塞进一个长滚动。
class _DirtyFileDiffPage extends StatefulWidget {
  const _DirtyFileDiffPage({required this.file, required this.fetchDiff});

  final GitDirtyFile file;
  final Future<GitWorkingDiff> Function(String path) fetchDiff;

  @override
  State<_DirtyFileDiffPage> createState() => _DirtyFileDiffPageState();
}

class _DirtyFileDiffPageState extends State<_DirtyFileDiffPage> {
  GitWorkingDiff? _diff;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _diff = null;
      _error = null;
    });
    try {
      final diff = await widget.fetchDiff(widget.file.diffPath);
      if (!mounted) return;
      setState(() {
        _diff = diff;
        // 服务端答了但 git 失败：按错误页画，不要当成「没有改动」。
        if (diff.error != null && diff.error!.isNotEmpty) _error = diff.error;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xFFffffff),
    appBar: AppBar(
      backgroundColor: const Color(0xFFf8fbff),
      iconTheme: const IconThemeData(color: Color(0xFF233249)),
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh_rounded),
          tooltip: t('retry'),
          onPressed: _load,
        ),
      ],
      title: Text(
        '${widget.file.status.isEmpty ? 'M' : widget.file.status}  ${widget.file.path}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: Color(0xFF20364d), fontSize: 14),
      ),
    ),
    body: _body(),
  );

  Widget _body() {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            t('airGitDiffFailed', {'msg': _error!}),
            style: const TextStyle(color: Color(0xFFb64e43), fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final diff = _diff;
    if (diff == null) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (diff.truncated)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            color: const Color(0x33a85a25),
            child: Text(
              t('airGitDiffTruncated').trim(),
              style: const TextStyle(color: Color(0xFFa85a25), fontSize: 11),
            ),
          ),
        Expanded(
          child: diff.patch.trim().isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      t('airGitFileNoDiff'),
                      style: const TextStyle(
                        color: Color(0xFF8a9aab),
                        fontSize: 13,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                )
              : SingleChildScrollView(
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: SelectableText.rich(
                      TextSpan(children: diffSpans(diff.patch)),
                      style: const TextStyle(
                        color: Color(0xFF233249),
                        fontFamily: 'monospace',
                        fontSize: 11,
                        height: 1.5,
                      ),
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}
