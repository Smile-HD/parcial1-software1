import 'package:test/test.dart';
import 'package:mobile_test_client/models/assistant_message.dart';

void main() {
  group('Assistant Message Model Tests (mobile:R3)', () {
    test('AssistantRequest serializes to JSON with request field', () {
      final req = AssistantRequest('list customers');
      expect(req.toJson(), equals({'request': 'list customers'}));
    });

    test('AssistantResponse parses executed response correctly', () {
      final json = {
        'outcome': 'executed',
        'action': 'list',
        'entity': 'Customer',
        'response': '[Customer[id=1, name=Alice]]',
      };

      final res = AssistantResponse.fromJson(json);
      expect(res.outcome, equals('executed'));
      expect(res.action, equals('list'));
      expect(res.entity, equals('Customer'));
      expect(res.response, equals('[Customer[id=1, name=Alice]]'));
      expect(res.isExecuted, isTrue);
      expect(res.isCanned, isFalse);
    });

    test('AssistantResponse parses canned fallback response verbatim', () {
      final json = {
        'outcome': 'canned',
        'action': null,
        'entity': null,
        'response': "I can help you with: list records (e.g. 'list customers'), count records, or create a record.",
      };

      final res = AssistantResponse.fromJson(json);
      expect(res.outcome, equals('canned'));
      expect(res.action, isNull);
      expect(res.entity, isNull);
      expect(res.response, contains('I can help you with:'));
      expect(res.isExecuted, isFalse);
      expect(res.isCanned, isTrue);
    });

    test('AssistantResponse parses unavailable response', () {
      final json = {
        'outcome': 'unavailable',
        'action': null,
        'entity': null,
        'response': 'The AI assistant is currently unavailable. CRUD operations work normally.',
      };

      final res = AssistantResponse.fromJson(json);
      expect(res.outcome, equals('unavailable'));
      expect(res.isUnavailable, isTrue);
    });
  });
}
