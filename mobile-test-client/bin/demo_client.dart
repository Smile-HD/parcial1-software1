import 'dart:io';
import 'package:mobile_test_client/config/api_config.dart';
import 'package:mobile_test_client/models/customer.dart';
import 'package:mobile_test_client/services/api_exceptions.dart';
import 'package:mobile_test_client/services/customer_service.dart';
import 'package:mobile_test_client/services/assistant_service.dart';

/// Standalone CLI demo harness for the mobile-test-client.
/// Exercises requirements mobile:R1 through mobile:R5 against the running System B backend.
void main(List<String> args) async {
  final baseUrl = args.isNotEmpty ? args[0] : ApiConfig.defaultBaseUrl;
  stdout.writeln('========================================================');
  stdout.writeln(' AI-UML Mobile Test Client — Demo Harness');
  stdout.writeln(' Target Backend: $baseUrl');
  stdout.writeln('========================================================\n');

  final config = ApiConfig(baseUrl: baseUrl);
  final customerService = CustomerService(config: config);
  final assistantService = AssistantService(config: config);

  // 1. Connectivity check
  stdout.write('[1/4] Checking backend connectivity... ');
  try {
    final customers = await customerService.listCustomers();
    stdout.writeln('ONLINE (${customers.length} existing customer records)');
  } on BackendConnectionException catch (e) {
    stdout.writeln('OFFLINE');
    stdout.writeln('  [EXPECTED ERROR SURFACE] ${e.message}');
    stdout.writeln('  Requirement mobile:R2 satisfied (explicit down reporting, no stale data).');
    exit(0);
  }

  // 2. Full CRUD cycle (mobile:R2)
  stdout.writeln('\n[2/4] Executing full CRUD cycle on demo entity Customer...');
  try {
    // CREATE
    final newCustomer = Customer(
      name: 'Examen Student',
      email: 'student@example.com',
      active: true,
    );
    stdout.write('  -> Creating Customer ("Examen Student")... ');
    final created = await customerService.createCustomer(newCustomer);
    stdout.writeln('CREATED (id: ${created.id})');

    // READ SINGLE
    stdout.write('  -> Reading Customer id ${created.id}... ');
    final fetched = await customerService.getCustomer(created.id!);
    stdout.writeln('OK ("${fetched.name}", email: "${fetched.email}")');

    // UPDATE
    stdout.write('  -> Updating Customer id ${created.id}... ');
    final toUpdate = fetched.copyWith(name: 'Examen Student (Updated)');
    final updated = await customerService.updateCustomer(toUpdate);
    stdout.writeln('OK ("${updated.name}")');

    // DELETE
    stdout.write('  -> Deleting Customer id ${created.id}... ');
    await customerService.deleteCustomer(created.id!);
    stdout.writeln('DELETED');

    // CONFIRM DELETION
    stdout.write('  -> Verifying deletion (expected 404)... ');
    try {
      await customerService.getCustomer(created.id!);
      stdout.writeln('FAIL (record still exists)');
    } on BackendApiException catch (e) {
      if (e.statusCode == 404) {
        stdout.writeln('CONFIRMED (404 Not Found)');
      } else {
        stdout.writeln('UNEXPECTED STATUS: ${e.statusCode}');
      }
    }
  } catch (e) {
    stdout.writeln('ERROR in CRUD cycle: $e');
  }

  // 3. Offline Assistant: Scripted query (mobile:R3)
  stdout.writeln('\n[3/4] Testing Offline Assistant: Scripted Query ("list customers")...');
  try {
    final res = await assistantService.sendQuery('list customers');
    stdout.writeln('  Outcome: ${res.outcome}');
    stdout.writeln('  Action:  ${res.action}');
    stdout.writeln('  Entity:  ${res.entity}');
    stdout.writeln('  Payload: ${res.response}');
  } catch (e) {
    stdout.writeln('  Assistant query error: $e');
  }

  // 4. Offline Assistant: Canned fallback (mobile:R3)
  stdout.writeln('\n[4/4] Testing Offline Assistant: Canned Fallback ("borrar toda la base de datos")...');
  try {
    final res = await assistantService.sendQuery('borrar toda la base de datos');
    stdout.writeln('  Outcome: ${res.outcome}');
    stdout.writeln('  Verbatim Canned Response:\n  "${res.response}"');
    if (res.isCanned) {
      stdout.writeln('  -> VERIFIED: Fallback returned verbatim without guessing.');
    }
  } catch (e) {
    stdout.writeln('  Assistant fallback query error: $e');
  }

  stdout.writeln('\n========================================================');
  stdout.writeln(' Demo harness complete.');
  stdout.writeln('========================================================');
}
