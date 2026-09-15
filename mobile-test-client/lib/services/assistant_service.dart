import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/assistant_message.dart';
import 'api_exceptions.dart';

/// Service invoking the offline assistant endpoint (design D11, mobile:R3).
class AssistantService {
  final ApiConfig config;
  final http.Client client;

  AssistantService({
    required this.config,
    http.Client? client,
  }) : client = client ?? http.Client();

  /// Sends a natural language query to POST /api/assistant.
  /// Handles both executed actions and canned fallback responses verbatim.
  Future<AssistantResponse> sendQuery(String query) async {
    final payload = AssistantRequest(query);

    final response = await _guardNetworkCall(() => client.post(
          Uri.parse(config.assistantUrl),
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: jsonEncode(payload.toJson()),
        ));

    if (response.statusCode == 200) {
      final Map<String, dynamic> body = jsonDecode(response.body) as Map<String, dynamic>;
      return AssistantResponse.fromJson(body);
    }

    throw BackendApiException(
        response.statusCode, 'Assistant endpoint returned error: ${response.body}');
  }

  Future<http.Response> _guardNetworkCall(Future<http.Response> Function() call) async {
    try {
      return await call();
    } on SocketException catch (e) {
      throw BackendConnectionException(
          'Cannot connect to backend assistant at ${config.baseUrl}: ${e.message}', e);
    } on http.ClientException catch (e) {
      throw BackendConnectionException(
          'Cannot connect to backend assistant at ${config.baseUrl}: ${e.message}', e);
    } catch (e) {
      if (e is BackendApiException || e is BackendConnectionException) rethrow;
      throw BackendConnectionException(
          'Unexpected error contacting backend assistant at ${config.baseUrl}: $e', e);
    }
  }
}
