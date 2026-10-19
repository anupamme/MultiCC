import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'air_service.dart';
import 'air_sync_store.dart';
import 'ws_ticket_service.dart';

export 'air_sync_store.dart' show AirPageResult;

/// One homepage transport shared by console, directories and task lists.
class AirSyncService extends ChangeNotifier {
  AirSyncService(
    this.service, {
    List<String> Function()? include,
    WsTicketClient? tickets,
    WebSocketChannel Function(Uri)? channelFactory,
    double Function()? random,
  }) : _include = include ?? (() => const []),
       _gate = WsTicketConnectionGate(tickets ?? service.airTickets()),
       _connect = channelFactory ?? WebSocketChannel.connect,
       _random = random ?? Random().nextDouble;

  final AirService service;
  final List<String> Function() _include;
  final WsTicketConnectionGate _gate;
  final WebSocketChannel Function(Uri) _connect;
  final double Function() _random;
  final _store = AirSyncStore();
  final _pages = <String, AirPageResult>{};
  final _stalePages = <String>{};
  final _pending = <String, String>{};
  final _failedPages = <String, DateTime>{};
  List<ExternalFleet> _fleets = const [];
  DateTime? _fleetsAt;
  AirSnapshot? snapshot;
  String status = 'connecting';
  bool _legacy = false, _closed = false, _paused = false, _connecting = false;
  bool _freshNeeded = false;
  int _serial = 0, _attempt = 0, _socketDay = 0;
  Future<AirSnapshot>? _inflight;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  Timer? _calibration, _reconnect, _pageRetry;

  bool get indexed => !_legacy && _store.metadata != null;
  int get _dayStart {
    final d = DateTime.now();
    return DateTime(d.year, d.month, d.day).millisecondsSinceEpoch;
  }

  void _emit() {
    if (_closed) return;
    if (indexed) {
      _store.trim([
        ..._include().take(50),
        ..._pages.values.expand((p) => p.ids),
      ]);
      snapshot = AirSnapshot.fromJson(
        _store.snapshot(),
        externalFleets: _fleets,
      );
    }
    if (!_paused) notifyListeners();
  }

  Future<AirSnapshot> refresh({bool fresh = false}) {
    if (_closed) return Future.error(StateError('Air sync closed'));
    _freshNeeded |= fresh;
    return _inflight ??= _refresh().whenComplete(() {
      _inflight = null;
      if (_closed || _paused) return;
      _calibration?.cancel();
      final seconds = status == 'offline'
          ? 5
          : _legacy
          ? 15
          : 60;
      _calibration = Timer(
        Duration(
          milliseconds: (seconds * 1000 * (1 + _random() * .08)).round(),
        ),
        _refreshQuietly,
      );
      if (_freshNeeded) _refreshQuietly();
      unawaited(_connectSocket());
    });
  }

  void _refreshQuietly() {
    unawaited(refresh().then<void>((_) {}, onError: (Object _) {}));
  }

  Future<AirSnapshot> _refresh() async {
    try {
      final fresh = _freshNeeded;
      _freshNeeded = false;
      if (_legacy) {
        snapshot = await service.load();
      } else {
        var response = await service.readAirSync({
          'dayStart': _dayStart,
          if (_store.metadata != null && !fresh)
            'cursor': _store.cursor
          else
            'include': _include().take(50).join(','),
        });
        if (_closed) throw StateError('Air sync closed');
        if (response == null) {
          _legacy = true;
          snapshot = await service.load();
        } else {
          if (response['reset'] == true) {
            response = await service.readAirSync({
              'dayStart': _dayStart,
              'include': _include().take(50).join(','),
            });
          }
          if (response == null) {
            throw const FormatException('Air sync unavailable');
          }
          if (response['tasks'] is List) {
            final sameEpoch =
                AirSyncStore.epoch('${response['cursor']}') ==
                AirSyncStore.epoch(_store.cursor);
            _store.replace(response);
            _invalidatePages(discard: !sameEpoch);
          } else {
            for (final event in response['events'] as List? ?? []) {
              final before = _store.cursor;
              if (!_store.delta(Map<String, dynamic>.from(event as Map))) {
                _freshNeeded = true;
                throw StateError('Air cursor gap');
              }
              if (_store.cursor != before) _invalidatePages();
            }
            if (response['cursor'] == _store.cursor &&
                response['taskStats'] is Map) {
              _store.metadata!['taskStats'] = response['taskStats'];
            }
          }
          status = response['degraded'] == true
              ? 'degraded'
              : _channel == null
              ? 'connecting'
              : 'live';
          if (_fleetsAt == null ||
              DateTime.now().difference(_fleetsAt!).inSeconds >= 60) {
            try {
              _fleets = await service.listExternalFleets();
              _fleetsAt = DateTime.now();
            } catch (_) {}
          }
          if (_closed) throw StateError('Air sync closed');
          if (_channel != null && _socketDay != _dayStart) _disconnect();
        }
      }
      _emit();
      if (indexed && _include().any((id) => !_store.rows.containsKey(id))) {
        page('include', {
          'status': 'all',
          'ids': _include().take(50).join(','),
          'limit': 50,
        });
      }
      return snapshot!;
    } catch (_) {
      if (!_closed) {
        status = 'offline';
        _emit();
      }
      rethrow;
    }
  }

  void _invalidatePages({bool discard = false}) {
    _serial++;
    if (discard) {
      _pages.clear();
      _stalePages.clear();
    } else {
      // Keep the visible rows mounted while their membership is revalidated.
      // Clearing them here briefly shrinks the list and clamps its scroll offset.
      _stalePages.addAll(_pages.keys);
    }
    _pending.clear();
    _failedPages.clear();
  }

  /// Called during build. Requests coalesce; only completed reads notify views.
  AirPageResult? page(String slot, Map<String, dynamic> options) {
    if (!indexed || _closed || _paused) return null;
    final query = {'limit': 20, ...options, 'dayStart': _dayStart};
    final signature = airPageSignature(query);
    final candidate = _pages[slot];
    final cached = candidate?.signature == signature ? candidate : null;
    if (cached != null && !_stalePages.contains(slot)) {
      // Returning to a cached query also supersedes a different pending read.
      _pending.remove(slot);
      return cached;
    }
    if (_pending[slot] == signature) return cached;
    final failed = _failedPages[signature];
    if (failed != null && DateTime.now().difference(failed).inSeconds < 5) {
      return cached;
    }
    _pending[slot] = signature;
    final serial = _serial;
    unawaited(() async {
      try {
        final result = await service.readAirPage(query);
        if (_closed ||
            _paused ||
            serial != _serial ||
            _pending[slot] != signature) {
          return;
        }
        final cursor = '${result['cursor']}';
        if (cursor != _store.cursor) {
          _refreshQuietly();
          return;
        }
        final page = AirPageResult(body: result, signature: signature);
        _pages.remove(slot);
        _pages[slot] = page;
        _stalePages.remove(slot);
        while (_pages.length > 16) {
          final oldest = _pages.keys.first;
          _pages.remove(oldest);
          _stalePages.remove(oldest);
        }
        _store.put(result['tasks'] as List, cursor);
        _emit();
      } catch (_) {
        if (_closed || serial != _serial) return;
        _failedPages[signature] = DateTime.now();
        _pageRetry ??= Timer(const Duration(seconds: 5), () {
          _pageRetry = null;
          _failedPages.clear();
          _emit();
        });
      } finally {
        if (serial == _serial && _pending[slot] == signature) {
          _pending.remove(slot);
        }
      }
    }());
    return cached;
  }

  Future<void> _connectSocket() async {
    if (!indexed ||
        _closed ||
        _paused ||
        _channel != null ||
        _connecting ||
        _reconnect != null) {
      return;
    }
    _connecting = true;
    final settings = service.settings, day = _dayStart;
    final attempt = _gate.begin(
      socketUri: buildMulticcWebSocketUri(
        host: settings.host,
        path: MulticcWsPath.meta,
        query: {'air': '1', 'cursor': _store.cursor, 'dayStart': '$day'},
      ),
      ticketEndpoint: Uri.parse(settings.buildHttpUrl('/api/auth/ws-ticket')),
      accessToken: settings.token,
    );
    try {
      final uri = await attempt.authorizedUri;
      if (_closed || _paused || !attempt.isCurrent) return;
      final channel = _connect(uri);
      _channel = channel;
      _socketDay = day;
      _subscription = channel.stream.listen(
        (raw) {
          if (_closed || _paused || channel != _channel) return;
          try {
            final event = Map<String, dynamic>.from(jsonDecode('$raw') as Map);
            switch (event['type']) {
              case 'air_reset':
                unawaited(
                  refresh(
                    fresh: true,
                  ).then<void>((_) {}, onError: (Object _) {}),
                );
              case 'air_delta':
                final before = _store.cursor;
                if (_store.delta(event)) {
                  if (_store.cursor != before) {
                    _invalidatePages();
                    _emit();
                  }
                } else {
                  _refreshQuietly();
                }
              case 'air_synced':
                status = event['degraded'] == true ? 'degraded' : 'live';
                if (event['cursor'] != _store.cursor) _refreshQuietly();
                _emit();
            }
          } catch (_) {
            _refreshQuietly();
          }
        },
        onError: (Object _) {
          if (channel == _channel) _retrySocket();
        },
        onDone: () {
          if (channel == _channel) _retrySocket();
        },
      );
      await channel.ready;
      if (channel != _channel || _closed || _paused) return;
      _attempt = 0;
    } catch (_) {
      if (!_closed && !_paused && attempt.isCurrent) _retrySocket();
    } finally {
      if (attempt.isCurrent) _connecting = false;
    }
  }

  void _disconnect() {
    _gate.invalidate();
    _connecting = false;
    final sub = _subscription;
    _subscription = null;
    unawaited(sub?.cancel());
    final channel = _channel;
    _channel = null;
    unawaited(channel?.sink.close());
  }

  void _retrySocket() {
    _disconnect();
    if (_closed || _paused || _reconnect != null) return;
    status = 'offline';
    _emit();
    _attempt++;
    final ms =
        (min(30000, 1000 * pow(2, min(_attempt, 5))) * (.8 + .4 * _random()))
            .round();
    _reconnect = Timer(Duration(milliseconds: ms), () {
      _reconnect = null;
      _refreshQuietly();
    });
  }

  void invalidate() {
    _invalidatePages();
    _emit();
    _refreshQuietly();
  }

  void pause() {
    _paused = true;
    _serial++;
    _pending.clear();
    _calibration?.cancel();
    _reconnect?.cancel();
    _reconnect = null;
    _pageRetry?.cancel();
    _pageRetry = null;
    _failedPages.clear();
    _disconnect();
  }

  Future<void> resume() async {
    if (_closed) return;
    _paused = false;
    await refresh();
  }

  @override
  void dispose() {
    _closed = true;
    pause();
    super.dispose();
  }
}
