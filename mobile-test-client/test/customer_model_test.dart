import 'package:test/test.dart';
import 'package:mobile_test_client/models/customer.dart';

void main() {
  group('Customer Model Tests (mobile:R2)', () {
    test('Can instantiate and convert to/from JSON with integer ID', () {
      final json = {
        'id': 1,
        'name': 'Alice Smith',
        'email': 'alice@example.com',
        'active': true,
      };

      final customer = Customer.fromJson(json);
      expect(customer.id, equals(1));
      expect(customer.name, equals('Alice Smith'));
      expect(customer.email, equals('alice@example.com'));
      expect(customer.active, isTrue);

      final serialized = customer.toJson();
      expect(serialized['id'], equals(1));
      expect(serialized['name'], equals('Alice Smith'));
      expect(serialized['email'], equals('alice@example.com'));
      expect(serialized['active'], isTrue);
    });

    test('Handles null ID for new entities being created', () {
      final json = {
        'name': 'Bob Jones',
        'email': 'bob@example.com',
      };

      final customer = Customer.fromJson(json);
      expect(customer.id, isNull);
      expect(customer.name, equals('Bob Jones'));
      expect(customer.email, equals('bob@example.com'));
      expect(customer.active, isTrue); // default true

      final serialized = customer.toJson();
      expect(serialized.containsKey('id'), isFalse);
      expect(serialized['name'], equals('Bob Jones'));
      expect(serialized['email'], equals('bob@example.com'));
    });

    test('Supports copyWith for updates', () {
      final customer = Customer(id: 1, name: 'Alice', email: 'alice@old.com');
      final updated = customer.copyWith(email: 'alice@new.com');

      expect(updated.id, equals(1));
      expect(updated.name, equals('Alice'));
      expect(updated.email, equals('alice@new.com'));
    });
  });
}
