import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/widgets/model_menu.dart';

const _groups = {
  'deepseek/deepseek-v4-flash': 'Open Source',
  'moonshotai/kimi-k3': 'Open Source',
  'claude-sonnet-5-5': 'Anthropic',
  'deepseek/deepseek-flash': 'DeepSeek Flash (byok)',
};

List<DropdownMenuItem<String>> _items({String filter = '', String? keep}) =>
    modelMenuItems(
      keys: ['', ..._groups.keys, '__custom__'],
      labelOf: (k) => k.isEmpty ? '默认' : (k == '__custom__' ? '自定义…' : k),
      groupOf: (k) => _groups[k] ?? '',
      style: const TextStyle(),
      headerStyle: const TextStyle(),
      filter: filter,
      keep: keep,
    );

List<String> _values(List<DropdownMenuItem<String>> items) => [
  for (final i in items) i.value!,
];

void main() {
  test('vendor groups become non-selectable headers, one per run of models', () {
    final items = _items();
    expect(_values(items), [
      '',
      '__group:Open Source',
      'deepseek/deepseek-v4-flash',
      'moonshotai/kimi-k3',
      '__group:Anthropic',
      'claude-sonnet-5-5',
      '__group:DeepSeek Flash (byok)',
      'deepseek/deepseek-flash',
      '__custom__',
    ]);
    for (final item in items) {
      expect(item.enabled, !item.value!.startsWith('__group:'));
    }
  });

  test('filter matches id/label, keeps default, custom and the current value', () {
    final values = _values(_items(filter: 'kimi', keep: 'claude-sonnet-5-5'));
    expect(values, [
      '',
      '__group:Open Source',
      'moonshotai/kimi-k3',
      '__group:Anthropic',
      'claude-sonnet-5-5',
      '__custom__',
    ]);
    // A filter with no hit drops every group header too.
    expect(_values(_items(filter: 'zzz')), ['', '__custom__']);
  });

  test('ungrouped catalogs stay flat', () {
    final items = modelMenuItems(
      keys: ['', 'grok-4.6', 'grok-4.5'],
      labelOf: (k) => k,
      groupOf: (_) => '',
      style: const TextStyle(),
      headerStyle: const TextStyle(),
    );
    expect(_values(items), ['', 'grok-4.6', 'grok-4.5']);
  });
}
