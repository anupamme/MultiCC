import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'settings_service.dart';

/// Live WorkBuddy (codebuddy) model catalog.
///
/// The CLI auto-updates faster than any bundled table (the old static list kept
/// offering gpt-5.6-* long after the CLI dropped them and missed
/// deepseek-v4.1-flash). GET /api/codebuddy/models parses `codebuddy --help` on
/// the host (1-hour server cache); this mirrors the result in-process so
/// repeated sheet opens do not re-fetch, and exposes a synchronous [options]
/// for the option builders that run inside build().
class CodebuddyModelsService {
  static const Duration _ttl = Duration(hours: 1);
  static const Duration _timeout = Duration(seconds: 20);

  /// The default entry plus the tier aliases — always valid `--model` values
  /// and not part of the CLI's concrete list.
  static const int _pinnedCount = 6;

  static List<MapEntry<String, String>>? _cache;
  static DateTime? _cachedAt;
  static Future<List<MapEntry<String, String>>>? _inflight;

  final SettingsService settings;
  CodebuddyModelsService({required this.settings});

  /// Cached catalog, or `[]` when nothing fresh has been fetched yet.
  static List<MapEntry<String, String>> get cached {
    final at = _cachedAt;
    final list = _cache;
    if (list == null || at == null) return const [];
    if (DateTime.now().difference(at) >= _ttl) return const [];
    return list;
  }

  /// Dropdown options: default + tiers pinned, then the live concrete ids.
  /// Falls back to the built-in table while the catalog is unknown.
  static List<MapEntry<String, String>> options() {
    final live = cached;
    if (live.isEmpty) return kCodebuddyModelOptions;
    return [...kCodebuddyModelOptions.take(_pinnedCount), ...live];
  }

  /// Fetch (or reuse) the catalog. Never throws — a failure leaves the static
  /// table in place. Returns `[]` when the catalog could not be read.
  Future<List<MapEntry<String, String>>> load() {
    final warm = cached;
    if (warm.isNotEmpty) return Future.value(warm);
    return _inflight ??= _fetch().whenComplete(() {
      _inflight = null;
    });
  }

  Future<List<MapEntry<String, String>>> _fetch() async {
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await http
          .get(
            Uri.parse(settings.buildHttpUrl('/api/codebuddy/models')),
            headers: headers,
          )
          .timeout(_timeout);
      if (res.statusCode != 200) return const [];
      final body = jsonDecode(res.body);
      if (body is! Map) return const [];
      final list = body['models'];
      if (list is! List) return const [];
      final out = <MapEntry<String, String>>[];
      for (final entry in list) {
        if (entry is! Map) continue;
        final model = entry['model']?.toString() ?? '';
        if (model.isEmpty) continue;
        final label = entry['label']?.toString() ?? '';
        out.add(MapEntry(model, label.isNotEmpty ? label : model));
      }
      // `source: fallback` means the host could not read the CLI and served its
      // own snapshot; do not pin that for an hour once the CLI recovers.
      if (out.isNotEmpty && body['source']?.toString() != 'fallback') {
        _cache = out;
        _cachedAt = DateTime.now();
      }
      return out;
    } catch (_) {
      return const [];
    }
  }
}
