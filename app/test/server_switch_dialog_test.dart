import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/connection_probe_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/server_switch_dialog.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await I18n.init('zh');
  });

  Future<SettingsService> settings() async {
    final s = await SettingsService.getInstance();
    await s.save(host: 'https://old.example', token: 'old-token');
    await s.clearServerHistory();
    await s.rememberServer('https://other.example', 'other-token');
    return s;
  }

  Future<void> open(
    WidgetTester tester,
    SettingsService s,
    http.Client client,
    void Function(ServerHistoryEntry?) result,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            return Scaffold(
              body: TextButton(
                onPressed: () async {
                  result(
                    await showDialog<ServerHistoryEntry>(
                      context: context,
                      builder: (_) => ServerSwitchDialog(
                        settings: s,
                        probe: ConnectionProbeService(client: client),
                      ),
                    ),
                  );
                },
                child: const Text('open'),
              ),
            );
          },
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'manual address clears old credential; failure keeps current server',
    (tester) async {
      final s = await settings();
      final requests = <http.Request>[];
      final client = MockClient((request) async {
        requests.add(request);
        return http.Response('', 401);
      });
      addTearDown(client.close);
      await open(tester, s, client, (_) => fail('must not switch'));
      await tester.enterText(
        find.byKey(const ValueKey('server-switch-host')),
        'https://new.example',
      );
      final password = tester.widget<TextField>(
        find.byKey(const ValueKey('server-switch-token')),
      );
      expect(password.controller!.text, isEmpty);
      expect(password.obscureText, isTrue);
      await tester.tap(find.byKey(const ValueKey('server-switch-connect')));
      await tester.pumpAndSettle();
      expect(requests.single.url.host, 'new.example');
      expect(requests.single.headers['X-Access-Token'], isNull);
      expect(find.text(t('connectErrorAuthentication')), findsOneWidget);
      expect(s.host, 'https://old.example');
      expect(s.token, 'old-token');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'history restores matching credential and returns only a verified target',
    (tester) async {
      final s = await settings();
      ServerHistoryEntry? selected;
      final paths = <String>[];
      final client = MockClient((request) async {
        paths.add(request.url.path);
        expect(request.url.host, 'other.example');
        expect(request.headers['X-Access-Token'], 'other-token');
        return http.Response(
          jsonEncode(
            request.url.path == '/api/server-info'
                ? {'product': 'multicc', 'appProtocolVersion': 1}
                : {},
          ),
          200,
        );
      });
      addTearDown(client.close);
      await open(tester, s, client, (result) => selected = result);
      await tester.tap(find.byKey(const ValueKey('server-switch-history')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('https://other.example').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('server-switch-connect')));
      await tester.pumpAndSettle();
      expect(paths, ['/api/server-info', '/readyz']);
      expect(selected!.host, 'https://other.example');
      expect(selected!.token, 'other-token');
      expect(s.host, 'https://old.example', reason: 'shell owns persistence');
    },
  );

  testWidgets('cancel never probes or changes settings', (tester) async {
    final s = await settings();
    var returned = false;
    final client = MockClient(
      (_) async => throw StateError('unexpected request'),
    );
    addTearDown(client.close);
    await open(tester, s, client, (result) {
      returned = true;
      expect(result, isNull);
    });
    await tester.enterText(
      find.byKey(const ValueKey('server-switch-host')),
      'https://new.example',
    );
    await tester.tap(find.text(t('cancel')));
    await tester.pumpAndSettle();
    expect(returned, isTrue);
    expect(s.host, 'https://old.example');
  });
}
