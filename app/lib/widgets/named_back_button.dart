import 'package:flutter/material.dart';

/// 返回名字由打开页面的路由提供；仍使用 Navigator，和系统返回走同一条路径。
class NamedBackButton extends StatelessWidget {
  const NamedBackButton({super.key, this.label});
  final String? label;
  @override
  Widget build(BuildContext context) {
    final arguments = ModalRoute.of(context)?.settings.arguments;
    final name =
        label ?? (arguments is Map ? arguments['backLabel'] as String? : null);
    if (name == null) return const BackButton();
    return Tooltip(
      message: MaterialLocalizations.of(context).backButtonTooltip,
      child: TextButton(
        onPressed: () => Navigator.maybePop(context),
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 4),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.chevron_left, size: 20),
            Flexible(
              child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ],
        ),
      ),
    );
  }
}
