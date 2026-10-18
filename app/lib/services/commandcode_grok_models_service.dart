import '../models/message.dart';
import 'live_model_catalog.dart';
import 'settings_service.dart';

/// Command Code's `--list-models` catalog (GET /api/commandcode/models), grouped
/// by the vendor's own sections. Falls back to [kCommandCodeModelOptions].
class CommandCodeModelsService {
  CommandCodeModelsService({required this.settings});
  final SettingsService settings;

  static final LiveModelCatalog catalog = LiveModelCatalog(
    path: '/api/commandcode/models',
  );

  static List<LiveModel> get cached => catalog.cached;
  static String groupOf(String id) => catalog.groupOf(id);

  /// Default entry pinned first, then the live ids (static table until loaded).
  static List<MapEntry<String, String>> options() {
    final live = cached;
    if (live.isEmpty) return kCommandCodeModelOptions;
    return [
      kCommandCodeModelOptions.first,
      for (final m in live) MapEntry(m.id, m.label),
    ];
  }

  Future<List<LiveModel>> load() => catalog.load(settings);
}

/// Grok Build's `grok models` list (GET /api/grok/models).
class GrokModelsService {
  GrokModelsService({required this.settings});
  final SettingsService settings;

  static final LiveModelCatalog catalog = LiveModelCatalog(
    path: '/api/grok/models',
  );

  static List<LiveModel> get cached => catalog.cached;

  static List<MapEntry<String, String>> options() {
    final live = cached;
    if (live.isEmpty) return kGrokModelOptions;
    return [
      kGrokModelOptions.first,
      for (final m in live) MapEntry(m.id, m.label),
    ];
  }

  Future<List<LiveModel>> load() => catalog.load(settings);
}
