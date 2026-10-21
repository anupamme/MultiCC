import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/provider_subscription.dart';
import 'package:multicc_app/widgets/external_access_hint.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SettingsService settings;
  setUpAll(() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'https://server.example',
      'multicc_token': 'fixture',
    });
    settings = await SettingsService.getInstance();
    await I18n.init('zh');
  });

  testWidgets('账号卡区分到期与续费，查询按账号隔离，失败不影响余量', (tester) async {
    final calls = <Uri>[];
    var data = <String, dynamic>{
      'status': 'ok',
      'subscription': {
        'currentPeriodEnd': DateTime(2030, 5, 12).millisecondsSinceEpoch,
      },
    };
    final service = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        calls.add(request.url);
        return http.Response(
          jsonEncode(data),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              const Text('剩余 80%'),
              ProviderSubscription(
                provider: const {
                  'appType': 'claude',
                  'id': 'p',
                  'officialAccountId': 'aaaaaaaaaaaaaaaa',
                },
                manage: service,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('本期到期'), findsOneWidget);
    expect(find.textContaining('下次续费：'), findsNothing);
    expect(calls.single.path, '/api/claude/subscription');
    expect(calls.single.queryParameters['account'], 'aaaaaaaaaaaaaaaa');
    data = {
      'status': 'ok',
      'subscription': {
        'nextBillingAt': DateTime(2030, 5, 12).millisecondsSinceEpoch,
      },
    };
    await tester.tap(find.text(t('subscriptionRefresh')));
    await tester.pumpAndSettle();
    expect(find.textContaining('下次续费：'), findsOneWidget);
    data = {'status': 'unavailable'};
    await tester.tap(find.text(t('subscriptionRefresh')));
    await tester.pumpAndSettle();
    expect(find.textContaining('暂时无法更新'), findsOneWidget);
    expect(find.text('剩余 80%'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('分享入口提供外网说明和配置按钮', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ExternalAccessHint(settings: settings)),
      ),
    );
    expect(find.text(t('externalAccessHint')), findsOneWidget);
    expect(find.text(t('externalAccessSetup')), findsOneWidget);
  });
}
