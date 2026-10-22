import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/claude_signin_dialog.dart';

// Adding a Claude account shows the link and a callback box (Magpie's flow)
// instead of launching claude.ai: a rejected paste says why and can be fixed,
// an accepted one waits on login-status and the dialog closes once signed in.

void main() {
  late SettingsService settings;
  const id = 'cccccccccccccccc';
  const url = 'https://claude.ai/oauth/authorize?code=true&state=st';

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await I18n.init('zh');
    SharedPreferences.setMockInitialValues({'multicc_host': 'http://server.example', 'multicc_token': 'secret'});
    settings = await SettingsService.getInstance();
  });

  testWidgets('pasting the callback finishes the sign-in on the server', (tester) async {
    final pastes = <String>[];
    var accepted = false;
    final manage = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        final path = request.url.path;
        if (path == '/api/claude/accounts/$id/login-callback') {
          final callback = (jsonDecode(request.body) as Map)['callback'] as String;
          pastes.add(callback);
          if (callback.contains('state=wrong')) {
            return http.Response(jsonEncode({'ok': false, 'error': '回调 state 不匹配'}), 400,
                headers: {'content-type': 'application/json; charset=utf-8'});
          }
          accepted = true;
          return http.Response(jsonEncode({'ok': true, 'accepted': true}), 200);
        }
        if (path == '/api/claude/accounts/$id/login-status') {
          return http.Response(
              jsonEncode(accepted ? {'state': 'complete', 'email': 'me@example.com'} : {'state': 'pending'}), 200);
        }
        return http.Response('{}', 404);
      }),
    );

    bool? result;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              result = await showDialog<bool>(
                context: context,
                builder: (_) => ClaudeSigninDialog(manage: manage, accountId: id, oauthUrl: url, name: 'VPS号'),
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pump();

    expect(find.text('登录 Claude 账号 · VPS号'), findsOneWidget);
    expect(find.text(url), findsOneWidget);
    final finish = find.widgetWithText(FilledButton, '完成登录');
    expect(tester.widget<FilledButton>(finish).onPressed, isNull);

    await tester.enterText(find.byType(TextField), 'http://localhost:54545/callback?code=bad&state=wrong');
    await tester.pump();
    await tester.tap(finish);
    await tester.pump();
    await tester.pump();
    expect(find.text('回调 state 不匹配'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);

    await tester.enterText(find.byType(TextField), 'http://localhost:54545/callback?code=good&state=st');
    await tester.pump();
    await tester.tap(finish);
    await tester.pump();
    await tester.pump();
    expect(pastes, hasLength(2));
    expect(find.text('已接收回调，正在换取令牌…'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);

    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.text('Claude 账号登录完成：me@example.com'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1300));
    await tester.pumpAndSettle();
    expect(result, isTrue);
    expect(find.byType(ClaudeSigninDialog), findsNothing);
  });
}
