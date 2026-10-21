import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../services/manage_service.dart';
import '../theme.dart';

class ProviderSubscription extends StatefulWidget {
  const ProviderSubscription({
    super.key,
    required this.provider,
    required this.manage,
  });
  final Map<String, dynamic> provider;
  final ManageService manage;

  @override
  State<ProviderSubscription> createState() => _ProviderSubscriptionState();
}

class _ProviderSubscriptionState extends State<ProviderSubscription> {
  Map<String, dynamic>? _result;
  bool _loading = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(ProviderSubscription oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.provider['id'] != widget.provider['id'] ||
        oldWidget.provider['appType'] != widget.provider['appType']) {
      _result = null;
      _load();
    }
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() => _loading = true);
    Map<String, dynamic> result;
    try {
      result = await widget.manage.fetchAccountSubscription(
        widget.provider['appType'] as String,
        accountId: widget.provider['officialAccountId'] as String?,
      );
    } catch (_) {
      result = {'status': 'unavailable'};
    }
    if (!mounted || generation != _generation) return;
    setState(() {
      _result = result;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final result = _result ?? <String, dynamic>{};
    final value =
        (result['status'] == 'ok'
                ? result['subscription']
                : result['subscription'] ?? widget.provider['subscription'])
            as Map?;
    String date(dynamic ms) => ms is num && ms.isFinite
        ? MaterialLocalizations.of(
            context,
          ).formatMediumDate(DateTime.fromMillisecondsSinceEpoch(ms.toInt()))
        : '';
    final renewal = date(value?['nextBillingAt']);
    final end = date(value?['currentPeriodEnd']);
    String text;
    if (value?['autoRenew'] == false) {
      text = t(
        end.isEmpty ? 'subscriptionCancelled' : 'subscriptionCancelledUntil',
        {'date': end},
      );
    } else if (renewal.isNotEmpty) {
      text = t(
        (value!['nextBillingAt'] as num) > DateTime.now().millisecondsSinceEpoch
            ? 'subscriptionNextBilling'
            : 'subscriptionLastBilling',
        {'date': renewal},
      );
    } else {
      text = end.isEmpty
          ? t('subscriptionUnknown')
          : t('subscriptionPeriodEnd', {'date': end});
    }
    if (_result?['status'] == 'no_auth') text = t('subscriptionLoginRequired');
    if (_result?['status'] == 'unavailable') {
      text = value == null
          ? t('subscriptionFetchFailed')
          : '$text · ${t('subscriptionFetchFailed')}';
    }
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Tooltip(
            message: t(
              value?['source'] == 'login'
                  ? 'subscriptionLoginSnapshot'
                  : 'subscriptionDateHint',
            ),
            child: Text(
              text,
              style: const TextStyle(fontSize: 12, color: AppColors.muted),
            ),
          ),
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: _loading ? null : _load,
                child: Text(
                  t(_loading ? 'subscriptionLoading' : 'subscriptionRefresh'),
                ),
              ),
              TextButton(
                onPressed: () => launchUrl(
                  Uri.parse(
                    widget.provider['appType'] == 'codex'
                        ? 'https://chatgpt.com/#settings/Account'
                        : 'https://claude.ai/settings/billing',
                  ),
                  mode: LaunchMode.externalApplication,
                ),
                child: Text(t('subscriptionOpenBilling')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
