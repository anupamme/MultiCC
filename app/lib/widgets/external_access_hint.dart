import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../services/settings_service.dart';
import '../theme.dart';

class ExternalAccessHint extends StatelessWidget {
  const ExternalAccessHint({super.key, required this.settings});
  final SettingsService settings;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          t('externalAccessHint'),
          style: const TextStyle(
            fontSize: 12,
            color: AppColors.muted,
            height: 1.5,
          ),
        ),
        TextButton.icon(
          onPressed: () => launchUrl(
            Uri.parse(settings.buildHttpUrl('/air?view=tunnel')),
            mode: LaunchMode.externalApplication,
          ),
          icon: const Icon(Icons.open_in_new, size: 15),
          label: Text(t('externalAccessSetup')),
        ),
      ],
    ),
  );
}
