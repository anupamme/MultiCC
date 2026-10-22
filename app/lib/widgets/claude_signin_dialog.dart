import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../services/manage_service.dart';
import '../theme.dart';

/// Account sign-in that opens nothing by itself (Magpie's flow): the whole
/// link to copy into whichever browser holds the account, then the address
/// that browser ends on — its own localhost, unreachable when MultiCC runs on
/// a server — pasted back so the server finishes the PKCE exchange. Both
/// vendors use multicc's own PKCE flow now, so the sheet only differs in its
/// copy and endpoint (`vendor`).
/// Pops `true` once the account is signed in.
class ClaudeSigninDialog extends StatefulWidget {
  const ClaudeSigninDialog({
    super.key,
    required this.manage,
    required this.accountId,
    required this.oauthUrl,
    required this.name,
    this.vendor = 'claude',
  });

  final ManageService manage;
  final String accountId;
  final String oauthUrl;
  final String name;
  final String vendor;

  @override
  State<ClaudeSigninDialog> createState() => _ClaudeSigninDialogState();
}

class _ClaudeSigninDialogState extends State<ClaudeSigninDialog> {
  final _callback = TextEditingController();
  Timer? _poll;
  bool _submitting = false;
  bool _accepted = false;
  bool _failed = false;
  bool _done = false;
  String _phase = '';
  String _error = '';

  bool get _locked => _submitting || _accepted || _failed || _done;

  bool get _isCodex => widget.vendor == 'codex';
  String get _titleKey =>
      _isCodex ? 'airOfficialAcctCodexSigninTitle' : 'airOfficialAcctSigninTitle';
  String get _step1Key =>
      _isCodex ? 'airOfficialAcctCodexSigninStep1' : 'airOfficialAcctSigninStep1';
  String get _step2Key =>
      _isCodex ? 'airOfficialAcctCodexSigninStep2' : 'airOfficialAcctSigninStep2';
  String get _doneKey =>
      _isCodex ? 'airOfficialAcctCodexLoginDone' : 'airOfficialAcctClaudeLoginDone';
  String get _doneEmailKey => _isCodex
      ? 'airOfficialAcctCodexLoginDoneEmail'
      : 'airOfficialAcctClaudeLoginDoneEmail';
  String get _failedKey => _isCodex
      ? 'airOfficialAcctCodexLoginFailed'
      : 'airOfficialAcctClaudeLoginFailed';

  @override
  void initState() {
    super.initState();
    _phase = t('airOfficialAcctSigninWaiting');
    _callback.addListener(() => setState(() {}));
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _check());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _callback.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    try {
      final s = await widget.manage.accountLoginStatus(widget.vendor, widget.accountId);
      if (!mounted || _done) return;
      final state = s['state']?.toString();
      if (state == 'complete') {
        _finish(s['email']?.toString() ?? '');
      } else if (state == 'error') {
        _poll?.cancel();
        setState(() {
          _failed = true;
          _submitting = false;
          _phase = '';
          _error = t(_failedKey, {'message': s['error']?.toString() ?? ''});
        });
      }
    } catch (_) {
      // transient — keep polling
    }
  }

  void _finish(String email) {
    _poll?.cancel();
    setState(() {
      _done = true;
      _submitting = false;
      _error = '';
      _phase = email.isEmpty
          ? t(_doneKey)
          : t(_doneEmailKey, {'email': email});
    });
    Future.delayed(const Duration(milliseconds: 1200), () {
      if (mounted) Navigator.of(context).pop(true);
    });
  }

  Future<void> _submit() async {
    final raw = _callback.text.trim();
    if (_locked || raw.isEmpty) return;
    setState(() {
      _submitting = true;
      _error = '';
      _phase = t('airOfficialAcctSigninSubmitting');
    });
    try {
      final r = await widget.manage.submitAccountLoginCallback(widget.vendor, widget.accountId, raw);
      if (!mounted) return;
      if (r['state'] == 'complete') {
        _finish('');
        return;
      }
      setState(() {
        _accepted = true;
        _submitting = false;
        _phase = t('airOfficialAcctPasteAccepted');
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _phase = t('airOfficialAcctSigninWaiting');
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.oauthUrl));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t('airOfficialAcctSigninCopied'))));
  }

  @override
  Widget build(BuildContext context) {
    const small = TextStyle(color: AppColors.muted, fontSize: 12, height: 1.5);
    return AlertDialog(
      title: Text(t(_titleKey, {'name': widget.name})),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_phase.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(_phase,
                      style: TextStyle(color: _done ? AppColors.success : AppColors.warning, fontSize: 12)),
                ),
              Text(t(_step1Key), style: small),
              const SizedBox(height: 6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.well,
                  border: Border.all(color: AppColors.line),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: SelectableText(widget.oauthUrl,
                    maxLines: 3,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: AppColors.text)),
              ),
              Wrap(spacing: 4, children: [
                TextButton.icon(
                  onPressed: _copy,
                  icon: const Icon(Icons.copy_rounded, size: 16),
                  label: Text(t('airOfficialAcctSigninCopy')),
                ),
                TextButton.icon(
                  onPressed: () => launchUrl(Uri.parse(widget.oauthUrl), mode: LaunchMode.externalApplication),
                  icon: const Icon(Icons.open_in_new_rounded, size: 16),
                  label: Text(t('airOfficialAcctSigninOpen')),
                ),
              ]),
              const SizedBox(height: 4),
              Text(t(_step2Key), style: small),
              const SizedBox(height: 8),
              TextField(
                controller: _callback,
                enabled: !_locked,
                autocorrect: false,
                enableSuggestions: false,
                style: const TextStyle(fontSize: 13),
                decoration: InputDecoration(
                  labelText: t('airOfficialAcctSigninCallbackLabel'),
                  hintText: t('airOfficialAcctPastePlaceholder'),
                  errorText: _error.isEmpty ? null : _error,
                  errorMaxLines: 4,
                ),
                onSubmitted: (_) => _submit(),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(_done),
          child: Text(_done ? t('airOfficialAcctSigninClose') : t('airOfficialAcctSigninLater')),
        ),
        FilledButton(
          onPressed: _locked || _callback.text.trim().isEmpty ? null : _submit,
          child: Text(t('airOfficialAcctPasteAction')),
        ),
      ],
    );
  }
}
