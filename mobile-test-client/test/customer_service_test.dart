import 'dart:convert';
import 'package:test/test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile_test_client/config/api_config.dart';
import 'package:mobile_test_client/models/customer.dart';
import 'package:mobile_test_client/services/customer_service.dart';
import 'package:mobile_test_client/services/api_exceptions.dart';

void main() {
  group('CustomerService Tests (mobile:R2)', () {
    late ApiConfig config;

    setUp(() {
      config = ApiConfig(baseUrl: 'http://localhost:8080');
    });

    test('listCustomers returns list of customers on 200 OK', () async {
      final mockClient = MockClient((request) async {
        expect(request.url.toString(), equals('http://localhost:8080/api/customers'));
        expect(request.method, equals('GET'));
        return http.Response(
          jsonEncode([
            {'id': 1, 'name': 'Alice', 'email': 'alice@example.com', 'active': true},
            {'id': 2, 'name': 'Bob', 'email': 'bob@example.com', 'active': false},
          ]),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = CustomerService(config: config, client: mockClient);
      final customers = await service.listCustomers();

      expect(customers.length, equals(2));
      expect(customers[0].name, equals('Alice'));
      expect(customers[1].name, equals('Bob'));
    });

    test('createCustomer sends POST and returns created Customer', () async {
      final newCustomer = Customer(name: 'Charlie', email: 'charlie@example.com');

      final mockClient = MockClient((request) async {
        expect(request.url.toString(), equals('http://localhost:8080/api/customers'));
        expect(request.method, equals('POST'));
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['name'], equals('Charlie'));
        expect(body['email'], equals('charlie@example.com'));

        return http.Response(
          jsonEncode({'id': 3, 'name': 'Charlie', 'email': 'charlie@example.com', 'active': true}),
          201,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = CustomerService(config: config, client: mockClient);
      final created = await service.createCustomer(newCustomer);

      expect(created.id, equals(3));
      expect(created.name, equals('Charlie'));
    });

    test('updateCustomer sends PUT and returns updated Customer', () async {
      final toUpdate = Customer(id: 3, name: 'Charlie Updated', email: 'charlie@example.com');

      final mockClient = MockClient((request) async {
        expect(request.url.toString(), equals('http://localhost:8080/api/customers/3'));
        expect(request.method, equals('PUT'));
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['name'], equals('Charlie Updated'));

        return http.Response(
          jsonEncode({'id': 3, 'name': 'Charlie Updated', 'email': 'charlie@example.com', 'active': true}),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = CustomerService(config: config, client: mockClient);
      final updated = await service.updateCustomer(toUpdate);

      expect(updated.name, equals('Charlie Updated'));
    });

    test('deleteCustomer sends DELETE to entity endpoint', () async {
      final mockClient = MockClient((request) async {
        expect(request.url.toString(), equals('http://localhost:8080/api/customers/3'));
        expect(request.method, equals('DELETE'));
        return http.Response('', 204);
      });

      final service = CustomerService(config: config, client: mockClient);
      await expectLater(service.deleteCustomer(3), completes);
    });

    test('Backend down reports explicit BackendConnectionException (mobile:R2)', () async {
      final mockClient = MockClient((request) async {
        throw http.ClientException('Failed to connect to localhost:8080');
      });

      final service = CustomerService(config: config, client: mockClient);

      expect(
        () => service.listCustomers(),
        throwsA(isA<BackendConnectionException>().having(
          (e) => e.message,
          'message',
          contains('Cannot connect to backend'),
        )),
      );
    });
  });
}
