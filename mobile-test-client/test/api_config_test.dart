import 'package:test/test.dart';
import 'package:mobile_test_client/config/api_config.dart';

void main() {
  group('ApiConfig Tests (mobile:R4)', () {
    test('Default base URL is http://localhost:8080', () {
      final config = ApiConfig();
      expect(config.baseUrl, equals('http://localhost:8080'));
      expect(config.customersUrl, equals('http://localhost:8080/api/customers'));
      expect(config.customerByIdUrl(42), equals('http://localhost:8080/api/customers/42'));
      expect(config.assistantUrl, equals('http://localhost:8080/api/assistant'));
    });

    test('Can configure custom base URL and trims trailing slash', () {
      final config = ApiConfig(baseUrl: 'http://192.168.0.147:8080/');
      expect(config.baseUrl, equals('http://192.168.0.147:8080'));
      expect(config.customersUrl, equals('http://192.168.0.147:8080/api/customers'));
      expect(config.assistantUrl, equals('http://192.168.0.147:8080/api/assistant'));
    });

    test('Rejects invalid base URLs', () {
      expect(() => ApiConfig(baseUrl: ''), throwsA(isA<ArgumentError>()));
      expect(() => ApiConfig(baseUrl: 'ftp://localhost:8080'), throwsA(isA<ArgumentError>()));
      expect(() => ApiConfig(baseUrl: 'not-a-valid-url'), throwsA(isA<ArgumentError>()));
    });

    test('updateBaseUrl updates URL dynamically at runtime', () {
      final config = ApiConfig();
      config.updateBaseUrl('http://10.0.2.2:8080');
      expect(config.baseUrl, equals('http://10.0.2.2:8080'));
      expect(config.customersUrl, equals('http://10.0.2.2:8080/api/customers'));
    });
  });
}
