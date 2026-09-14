import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/customer.dart';
import 'api_exceptions.dart';

/// Service executing CRUD operations against the generated Spring Boot backend.
/// Meets requirement mobile:R2 (full CRUD cycle + explicit down reporting).
class CustomerService {
  final ApiConfig config;
  final http.Client client;

  CustomerService({
    required this.config,
    http.Client? client,
  }) : client = client ?? http.Client();

  /// GET /api/customers
  Future<List<Customer>> listCustomers() async {
    final response = await _guardNetworkCall(() => client.get(
          Uri.parse(config.customersUrl),
          headers: {'accept': 'application/json'},
        ));

    if (response.statusCode == 200) {
      final List<dynamic> data = jsonDecode(response.body) as List<dynamic>;
      return data.map((e) => Customer.fromJson(e as Map<String, dynamic>)).toList();
    }
    throw BackendApiException(response.statusCode, 'Failed to list customers: ${response.body}');
  }

  /// GET /api/customers/:id
  Future<Customer> getCustomer(int id) async {
    final response = await _guardNetworkCall(() => client.get(
          Uri.parse(config.customerByIdUrl(id)),
          headers: {'accept': 'application/json'},
        ));

    if (response.statusCode == 200) {
      return Customer.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
    }
    throw BackendApiException(response.statusCode, 'Customer $id not found: ${response.body}');
  }

  /// POST /api/customers
  Future<Customer> createCustomer(Customer customer) async {
    final response = await _guardNetworkCall(() => client.post(
          Uri.parse(config.customersUrl),
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: jsonEncode(customer.toJson()),
        ));

    if (response.statusCode == 200 || response.statusCode == 201) {
      return Customer.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
    }
    throw BackendApiException(response.statusCode, 'Failed to create customer: ${response.body}');
  }

  /// PUT /api/customers/:id
  Future<Customer> updateCustomer(Customer customer) async {
    if (customer.id == null) {
      throw ArgumentError('Cannot update customer without ID');
    }
    final response = await _guardNetworkCall(() => client.put(
          Uri.parse(config.customerByIdUrl(customer.id!)),
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: jsonEncode(customer.toJson()),
        ));

    if (response.statusCode == 200) {
      return Customer.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
    }
    throw BackendApiException(response.statusCode, 'Failed to update customer: ${response.body}');
  }

  /// DELETE /api/customers/:id
  Future<void> deleteCustomer(int id) async {
    final response = await _guardNetworkCall(() => client.delete(
          Uri.parse(config.customerByIdUrl(id)),
          headers: {'accept': 'application/json'},
        ));

    if (response.statusCode != 200 && response.statusCode != 204) {
      throw BackendApiException(response.statusCode, 'Failed to delete customer $id: ${response.body}');
    }
  }

  /// Wraps network calls to surface explicit BackendConnectionException when backend is down.
  Future<http.Response> _guardNetworkCall(Future<http.Response> Function() call) async {
    try {
      return await call();
    } on SocketException catch (e) {
      throw BackendConnectionException(
          'Cannot connect to backend at ${config.baseUrl}: ${e.message}', e);
    } on http.ClientException catch (e) {
      throw BackendConnectionException(
          'Cannot connect to backend at ${config.baseUrl}: ${e.message}', e);
    } catch (e) {
      if (e is BackendApiException || e is BackendConnectionException) rethrow;
      throw BackendConnectionException(
          'Unexpected error contacting backend at ${config.baseUrl}: $e', e);
    }
  }
}
