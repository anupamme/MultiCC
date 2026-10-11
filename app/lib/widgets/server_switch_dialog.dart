import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/connection_probe_service.dart';
import '../services/settings_service.dart';

/// Only returns a verified connection. Cancelling or a failed probe never
/// changes the current server; the shell owns saving and reconnecting.
class ServerSwitchDialog extends StatefulWidget {
  const ServerSwitchDialog({super.key, required this.settings, this.probe});

  final SettingsService settings;
  final ConnectionProbeService? probe;

  @override
  State<ServerSwitchDialog> createState() => _ServerSwitchDialogState();
}

class _ServerSwitchDialogState extends State<ServerSwitchDialog> {
  late final _host = TextEditingController(text: widget.settings.host);
  late final _token = TextEditingController(text: widget.settings.token);
  late final _probe = widget.probe ?? ConnectionProbeService();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _host.dispose();
    _token.dispose();
    if (widget.probe == null) _probe.close();
    super.dispose();
  }

  Future<void> _connect() async {
    if (_busy) return;
    final host = _host.text.trim();
    final token = _token.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    ConnectionProbeResult result;
    try {
      result = await _probe.probe(host: host, token: token);
    } catch (_) {
      result = const ConnectionProbeResult.failed(
        ConnectionProbeFailure.unreachable,
      );
    }
    if (!mounted) return;
    if (result.ok) {
      Navigator.pop(
        context,
        ServerHistoryEntry(host: result.normalizedHost, token: token),
      );
      return;
    }
    setState(() {
      _busy = false;
      _error = t(switch (result.failure!) {
        ConnectionProbeFailure.invalidAddress => 'connectErrorInvalidAddress',
        ConnectionProbeFailure.insecureAddress => 'connectErrorInsecureAddress',
        ConnectionProbeFailure.unreachable => 'connectErrorUnreachable',
        ConnectionProbeFailure.authentication => 'connectErrorAuthentication',
        ConnectionProbeFailure.notMulticc => 'connectErrorNotMulticc',
        ConnectionProbeFailure.notReady => 'connectErrorNotReady',
        ConnectionProbeFailure.incompatible => 'connectErrorIncompatible',
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    final history = widget.settings.serverHistory;
    return AlertDialog(
      title: Text(I18n.instance.lang == 'en' ? 'Switch server' : '切换服务器'),
      scrollable: true,
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (history.isNotEmpty) ...[
              DropdownButtonFormField<int>(
                key: const ValueKey('server-switch-history'),
                isExpanded: true,
                decoration: InputDecoration(labelText: t('history')),
                items: [
                  for (var i = 0; i < history.length; i++)
                    DropdownMenuItem(
                      value: i,
                      child: Text(
                        history[i].host,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: _busy
                    ? null
                    : (index) {
                        if (index == null) return;
                        setState(() {
                          _host.text = history[index].host;
                          _token.text = history[index].token;
                          _error = null;
                        });
                      },
              ),
              const SizedBox(height: 16),
            ],
            TextField(
              key: const ValueKey('server-switch-host'),
              controller: _host,
              enabled: !_busy,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: InputDecoration(labelText: t('serverAddress')),
              // A manually entered host must not receive the old host's token.
              onChanged: (_) => setState(() {
                _token.clear();
                _error = null;
              }),
            ),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('server-switch-token'),
              controller: _token,
              enabled: !_busy,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                labelText: 'Access Token',
                hintText: t('optionalIfUnset'),
              ),
              onSubmitted: (_) => _connect(),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(t('cancel')),
        ),
        FilledButton(
          key: const ValueKey('server-switch-connect'),
          onPressed: _busy ? null : _connect,
          child: Text(t(_busy ? 'connecting' : 'connect')),
        ),
      ],
    );
  }
}
