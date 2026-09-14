import 'dart:convert';
import 'package:test/test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile_test_client/config/api_config.dart';
import 'package:mobile_test_client/services/assistant_service.dart';
import 'package:mobile_test_client/services/api_exceptions.dart';

void main() {
  group('AssistantService Tests (mobile:R3)', () {
    late ApiConfig config;

    setUp(() {
      config = ApiConfig(baseUrl: 'http://localhost:8080');
    });

    test('sendQuery sends POST /api/assistant and parses executed response', () async {
      final mockClient = MockClient((request) async {
        expect(request.url.toString(), equals('http://localhost:8080/api/assistant'));
        expect(request.method, equals('POST'));
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['request'], equals('list customers'));

        return http.Response(
          jsonEncode({
            'outcome': 'executed',
            'action': 'list',
            'entity': 'Customer',
            'response': '[Customer[id=1, name=Alice]]',
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = AssistantService(config: config, client: mockClient);
      final response = await service.sendQuery('list customers');

      expect(response.outcome, equals('executed'));
      expect(response.action, equals('list'));
      expect(response.entity, equals('Customer'));
      expect(response.response, contains('Customer[id=1, name=Alice]'));
    });

    test('sendQuery surfaces canned fallback verbatim for unmappable queries (mobile:R3)', () async {
      const cannedText = "I can help you with: list records (e.g. 'list customers'), count records, or create a record.";
      final mockClient = MockClient((request) async {
        return http.Response(
          jsonEncode({
            'outcome': 'canned',
            'action': null,
            'entity': null,
            'response': cannedText,
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = AssistantService(config: config, client: mockClient);
      final response = await service.sendQuery('delete all records from database');

      expect(response.outcome, equals('canned'));
      expect(response.response, equals(cannedText));
    });

    test('Backend down during assistant call throws BackendConnectionException', () async {
      final mockClient = MockClient((request) async {
        throw http.ClientException('Connection refused');
      });

      final service = AssistantService(config: config, client: mockClient);

      expect(
        () => service.sendQuery('list customers'),
        throwsA(isA<BackendConnectionException>()),
      );
    });
  });
}
