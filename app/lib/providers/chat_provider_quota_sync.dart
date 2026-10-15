part of 'chat_provider.dart';

extension ProviderQuotaSync on ChatProvider {
  /// 供应商快照属于账号，不属于一轮对话；只接受当前线路及更新的版本。
  bool applyProviderLimitSnapshot(Map<String, dynamic> data) {
    if (data['providerId'] != _providerLimitId ||
        data['appType'] != _providerLimitAppType || data['bar'] is! Map) {
      return false;
    }
    final previous = (_providerLimitSnapshot?['updatedAt'] as num?) ?? 0;
    final updated = (data['updatedAt'] as num?) ?? 0;
    if (updated < previous) return false;
    _providerLimitSnapshot = data;
    final response = <String, dynamic>{
      'status': 'ok', 'fetchedAt': data['fetchedAt'], 'bar': data['bar'],
    };
    if (data['kind'] == 'ark') {
      _arkQuota = response;
    } else if (data['kind'] == 'kimi') {
      _kimiQuota = response;
    } else if (_cli.isClaudeFamily && isClaudeProviderBaseUrl(_providerBaseUrl) &&
        (data['dto'] as Map?)?['kind'] == 'window') {
      _claudeUsage = response;
      _activeProviderLimit = null;
    } else {
      _activeProviderLimit = data;
    }
    _notifyQuotaChanged();
    return true;
  }

  Future<void> _fetchActiveProviderLimit(
    int revision,
    String appType,
    String providerId,
  ) async {
    final inFlightKey = '$appType:$providerId';
    if (_providerLimitInFlightKey == inFlightKey) return;
    _providerLimitInFlightKey = inFlightKey;
    try {
      final cached = await _quota.fetchProviderLimitSnapshot(appType, providerId);
      if (revision != _providerLimitRevision) return;
      if (cached != null && cached['type'] == 'provider_limit_updated' &&
          applyProviderLimitSnapshot(cached) && cached['stale'] != true) {
        return;
      }
      final data = await _quota.fetchProviderBalance(appType, providerId);
      if (revision != _providerLimitRevision ||
          appType != _providerLimitAppType ||
          providerId != _providerLimitId) {
        return;
      }
      // A failed query must NOT erase a good bar. The web's refreshProviderLimit
      // returns on failure without touching the bars, and the server answers a
      // transient upstream failure with its cached last-known-good bar for
      // exactly this reason; nulling it here (the old behavior) meant one 20s
      // timeout hid the chip until the user switched provider or CLI again.
      // Nothing is kept across an identity change: that path clears the field.
      if (data == null || data['ok'] != true) return;
      final snapshot = data['snapshot'];
      if (snapshot is Map) { applyProviderLimitSnapshot(Map<String, dynamic>.from(snapshot)); return; }
      if (_providerLimitSnapshot != null) return;
      _activeProviderLimit = data;
      _notifyQuotaChanged();
    } finally {
      if (_providerLimitInFlightKey == inFlightKey) {
        _providerLimitInFlightKey = null;
      }
    }
  }

}
