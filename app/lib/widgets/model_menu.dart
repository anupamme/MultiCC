import 'package:flutter/material.dart';

/// Past this many real choices the model pickers show a search box.
const int kModelSearchMin = 12;

/// Items for a model dropdown. Models whose [groupOf] is non-empty are listed
/// under a non-selectable group header (the vendor's own sections, e.g. Command
/// Code's Open Source / Anthropic / OpenAI); the rest are flat. A non-empty
/// [filter] keeps only models whose label or id contains it, but never drops
/// the entry in [keep] (the current value — a DropdownButton asserts it exists)
/// nor [pinned] ones (default / custom).
List<DropdownMenuItem<String>> modelMenuItems({
  required List<String> keys,
  required String Function(String key) labelOf,
  required String Function(String key) groupOf,
  required TextStyle style,
  required TextStyle headerStyle,
  Set<String> pinned = const {'', '__custom__'},
  String filter = '',
  String? keep,
}) {
  final needle = filter.trim().toLowerCase();
  final items = <DropdownMenuItem<String>>[];
  String? openGroup;
  for (final key in keys) {
    final label = labelOf(key);
    final special = pinned.contains(key) || key == keep;
    if (needle.isNotEmpty &&
        !special &&
        !'$label $key'.toLowerCase().contains(needle)) {
      continue;
    }
    final group = pinned.contains(key) ? '' : groupOf(key);
    if (group.isNotEmpty && group != openGroup) {
      items.add(
        DropdownMenuItem<String>(
          value: '__group:$group',
          enabled: false,
          child: Text(group, style: headerStyle),
        ),
      );
    }
    openGroup = group.isEmpty ? null : group;
    items.add(
      DropdownMenuItem<String>(
        value: key,
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: style,
        ),
      ),
    );
  }
  return items;
}

/// The search box above a long model dropdown.
Widget modelSearchField({
  required ValueChanged<String> onChanged,
  required InputDecoration decoration,
  required TextStyle style,
  Key? key,
}) {
  return TextField(
    key: key ?? const ValueKey('model-search'),
    onChanged: onChanged,
    style: style,
    decoration: decoration.copyWith(
      hintText: '搜索模型…',
      prefixIcon: const Icon(Icons.search, size: 16),
      isDense: true,
    ),
  );
}
