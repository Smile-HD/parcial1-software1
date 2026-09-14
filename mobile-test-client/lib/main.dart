import 'dart:convert';
import 'package:flutter/material.dart';
import 'config/api_config.dart';
import 'models/customer.dart';
import 'models/assistant_message.dart';
import 'services/api_exceptions.dart';
import 'services/customer_service.dart';
import 'services/assistant_service.dart';

void main() {
  runApp(const MobileTestClientApp());
}

class MobileTestClientApp extends StatefulWidget {
  const MobileTestClientApp({super.key});

  @override
  State<MobileTestClientApp> createState() => _MobileTestClientAppState();
}

class _MobileTestClientAppState extends State<MobileTestClientApp> {
  final ApiConfig _config = ApiConfig();
  late CustomerService _customerService;
  late AssistantService _assistantService;

  @override
  void initState() {
    super.initState();
    _customerService = CustomerService(config: _config);
    _assistantService = AssistantService(config: _config);
  }

  void _updateBaseUrl(String newUrl) {
    setState(() {
      _config.updateBaseUrl(newUrl);
      _customerService = CustomerService(config: _config);
      _assistantService = AssistantService(config: _config);
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'UML Mobile Client',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1E88E5),
          brightness: Brightness.light,
        ),
        useMaterial3: true,
      ),
      home: MainNavigationShell(
        config: _config,
        customerService: _customerService,
        assistantService: _assistantService,
        onBaseUrlChanged: _updateBaseUrl,
      ),
    );
  }
}

class MainNavigationShell extends StatefulWidget {
  final ApiConfig config;
  final CustomerService customerService;
  final AssistantService assistantService;
  final ValueChanged<String> onBaseUrlChanged;

  const MainNavigationShell({
    super.key,
    required this.config,
    required this.customerService,
    required this.assistantService,
    required this.onBaseUrlChanged,
  });

  @override
  State<MainNavigationShell> createState() => _MainNavigationShellState();
}

class _MainNavigationShellState extends State<MainNavigationShell> {
  int _currentIndex = 0;

  @override
  Widget build(BuildContext context) {
    final screens = [
      CrudScreen(customerService: widget.customerService),
      AssistantScreen(assistantService: widget.assistantService),
      SettingsScreen(
        config: widget.config,
        customerService: widget.customerService,
        onBaseUrlChanged: widget.onBaseUrlChanged,
      ),
    ];

    return Scaffold(
      body: screens[_currentIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (idx) => setState(() => _currentIndex = idx),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.people_alt_outlined),
            selectedIcon: Icon(Icons.people_alt),
            label: 'CRUD Clientes',
          ),
          NavigationDestination(
            icon: Icon(Icons.smart_toy_outlined),
            selectedIcon: Icon(Icons.smart_toy),
            label: 'Asistente IA',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Ajustes',
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// SCREEN 1: CRUD CLIENTES (Requirement mobile:R2)
// ---------------------------------------------------------------------------
class CrudScreen extends StatefulWidget {
  final CustomerService customerService;

  const CrudScreen({super.key, required this.customerService});

  @override
  State<CrudScreen> createState() => _CrudScreenState();
}

class _CrudScreenState extends State<CrudScreen> {
  List<Customer> _customers = [];
  bool _isLoading = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _loadCustomers();
  }

  Future<void> _loadCustomers() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final list = await widget.customerService.listCustomers();
      setState(() {
        _customers = list;
        _isLoading = false;
      });
    } on BackendConnectionException catch (e) {
      setState(() {
        _customers = []; // Do NOT display stale data (mobile:R2)
        _errorMessage = e.message;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _customers = [];
        _errorMessage = 'Error inesperado: $e';
        _isLoading = false;
      });
    }
  }

  void _showCreateDialog() {
    final nameController = TextEditingController();
    final emailController = TextEditingController();

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Nuevo Cliente'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameController,
              decoration: const InputDecoration(labelText: 'Nombre Completo'),
            ),
            TextField(
              controller: emailController,
              decoration: const InputDecoration(labelText: 'Correo Electrónico'),
              keyboardType: TextInputType.emailAddress,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () async {
              final name = nameController.text.trim();
              final email = emailController.text.trim();
              if (name.isEmpty || email.isEmpty) return;
              Navigator.pop(ctx);

              try {
                await widget.customerService.createCustomer(
                  Customer(name: name, email: email),
                );
                _loadCustomers();
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Error al crear: $e')),
                  );
                }
              }
            },
            child: const Text('Guardar'),
          ),
        ],
      ),
    );
  }

  void _showEditDialog(Customer customer) {
    final nameController = TextEditingController(text: customer.name);
    final emailController = TextEditingController(text: customer.email);

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Editar Cliente #${customer.id}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameController,
              decoration: const InputDecoration(labelText: 'Nombre Completo'),
            ),
            TextField(
              controller: emailController,
              decoration: const InputDecoration(labelText: 'Correo Electrónico'),
              keyboardType: TextInputType.emailAddress,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () async {
              final name = nameController.text.trim();
              final email = emailController.text.trim();
              if (name.isEmpty || email.isEmpty) return;
              Navigator.pop(ctx);

              try {
                await widget.customerService.updateCustomer(
                  customer.copyWith(name: name, email: email),
                );
                _loadCustomers();
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Error al actualizar: $e')),
                  );
                }
              }
            },
            child: const Text('Actualizar'),
          ),
        ],
      ),
    );
  }

  Future<void> _deleteCustomer(Customer customer) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirmar Eliminación'),
        content: Text('¿Desea eliminar al cliente "${customer.name}"?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Eliminar'),
          ),
        ],
      ),
    );

    if (confirmed == true && customer.id != null) {
      try {
        await widget.customerService.deleteCustomer(customer.id!);
        _loadCustomers();
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Error al eliminar: $e')),
          );
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Clientes (CRUD Backend)'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadCustomers,
            tooltip: 'Recargar',
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showCreateDialog,
        icon: const Icon(Icons.add),
        label: const Text('Nuevo'),
      ),
      body: RefreshIndicator(
        onRefresh: _loadCustomers,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_errorMessage != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off, size: 64, color: Colors.redAccent),
              const SizedBox(height: 16),
              const Text(
                'Servidor Fuera de Línea',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              Text(
                _errorMessage!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.black54),
              ),
              const SizedBox(height: 16),
              FilledButton.tonal(
                onPressed: _loadCustomers,
                child: const Text('Reintentar Conexión'),
              ),
            ],
          ),
        ),
      );
    }

    if (_customers.isEmpty) {
      return const Center(
        child: Text('No hay clientes registrados en el backend.'),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _customers.length,
      itemBuilder: (ctx, idx) {
        final c = _customers[idx];
        return Card(
          margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: ListTile(
            leading: CircleAvatar(
              child: Text(c.id != null ? '${c.id}' : '?'),
            ),
            title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.bold)),
            subtitle: Text(c.email),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  icon: const Icon(Icons.edit_outlined, color: Colors.blue),
                  onPressed: () => _showEditDialog(c),
                ),
                IconButton(
                  icon: const Icon(Icons.delete_outline, color: Colors.red),
                  onPressed: () => _deleteCustomer(c),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// SCREEN 2: ASISTENTE IA OFFLINE (Requirement mobile:R3)
// ---------------------------------------------------------------------------
class AssistantScreen extends StatefulWidget {
  final AssistantService assistantService;

  const AssistantScreen({super.key, required this.assistantService});

  @override
  State<AssistantScreen> createState() => _AssistantScreenState();
}

class _AssistantScreenState extends State<AssistantScreen> {
  final TextEditingController _queryController = TextEditingController();
  final List<Map<String, dynamic>> _messages = [];
  bool _isThinking = false;

  final List<String> _quickPrompts = [
    'list customers',
    'how many customers',
    'create customer',
    'borrar toda la base de datos',
  ];

  Future<void> _submitQuery(String query) async {
    final text = query.trim();
    if (text.isEmpty || _isThinking) return;

    setState(() {
      _messages.add({'sender': 'user', 'text': text});
      _isThinking = true;
    });
    _queryController.clear();

    try {
      final response = await widget.assistantService.sendQuery(text);
      setState(() {
        _messages.add({
          'sender': 'assistant',
          'response': response,
        });
        _isThinking = false;
      });
    } on BackendConnectionException catch (e) {
      setState(() {
        _messages.add({
          'sender': 'system',
          'text': 'Error de conexión: ${e.message}',
        });
        _isThinking = false;
      });
    } catch (e) {
      setState(() {
        _messages.add({
          'sender': 'system',
          'text': 'Error al consultar asistente: $e',
        });
        _isThinking = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Asistente IA Offline'),
      ),
      body: Column(
        children: [
          // Quick prompt chips
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: _quickPrompts.map((p) {
                return Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ActionChip(
                    label: Text(p),
                    onPressed: () => _submitQuery(p),
                  ),
                );
              }).toList(),
            ),
          ),
          const Divider(height: 1),

          // Messages list
          Expanded(
            child: _messages.isEmpty
                ? const Center(
                    child: Text(
                      'Envía una consulta al Asistente local\n(ej: "list customers" o preguntas fuera de alcance)',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.black54),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _messages.length,
                    itemBuilder: (ctx, idx) {
                      final item = _messages[idx];
                      if (item['sender'] == 'user') {
                        return _buildUserBubble(item['text'] as String);
                      } else if (item['sender'] == 'assistant') {
                        return _buildAssistantBubble(item['response'] as AssistantResponse);
                      } else {
                        return _buildSystemAlert(item['text'] as String);
                      }
                    },
                  ),
          ),

          if (_isThinking)
            const LinearProgressIndicator(),

          // Input field
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 4)],
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _queryController,
                    decoration: const InputDecoration(
                      hintText: 'Escribe tu consulta...',
                      border: InputBorder.none,
                      contentPadding: EdgeInsets.symmetric(horizontal: 12),
                    ),
                    onSubmitted: _submitQuery,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.send),
                  color: Theme.of(context).colorScheme.primary,
                  onPressed: () => _submitQuery(_queryController.text),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildUserBubble(String text) {
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primaryContainer,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(text),
      ),
    );
  }

  Widget _buildAssistantBubble(AssistantResponse res) {
    Color badgeColor = Colors.blue;
    String badgeText = res.outcome.toUpperCase();

    if (res.isExecuted) {
      badgeColor = Colors.green;
    } else if (res.isCanned) {
      badgeColor = Colors.orange;
    } else if (res.isUnavailable || res.isRefused) {
      badgeColor = Colors.red;
    }

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.grey.shade100,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: Colors.grey.shade300),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: badgeColor,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    badgeText,
                    style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold),
                  ),
                ),
                if (res.action != null) ...[
                  const SizedBox(width: 6),
                  Text('Acción: ${res.action}', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                ],
              ],
            ),
            const SizedBox(height: 8),
            Text(res.response, style: const TextStyle(fontSize: 14)),
          ],
        ),
      ),
    );
  }

  Widget _buildSystemAlert(String text) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Colors.red.shade50,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.red.shade200),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: Colors.red, size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: const TextStyle(color: Colors.red, fontSize: 12))),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// SCREEN 3: AJUSTES DE ENDPOINT (Requirement mobile:R4)
// ---------------------------------------------------------------------------
class SettingsScreen extends StatefulWidget {
  final ApiConfig config;
  final CustomerService customerService;
  final ValueChanged<String> onBaseUrlChanged;

  const SettingsScreen({
    super.key,
    required this.config,
    required this.customerService,
    required this.onBaseUrlChanged,
  });

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late TextEditingController _urlController;
  String? _testResult;
  bool _isTesting = false;

  @override
  void initState() {
    super.initState();
    _urlController = TextEditingController(text: widget.config.baseUrl);
  }

  Future<void> _testConnection() async {
    setState(() {
      _isTesting = true;
      _testResult = null;
    });

    try {
      final customers = await widget.customerService.listCustomers();
      setState(() {
        _testResult = 'Conexión exitosa. (${customers.length} clientes encontrados)';
        _isTesting = false;
      });
    } on BackendConnectionException catch (e) {
      setState(() {
        _testResult = 'Error de conexión: ${e.message}';
        _isTesting = false;
      });
    } catch (e) {
      setState(() {
        _testResult = 'Error: $e';
        _isTesting = false;
      });
    }
  }

  void _saveUrl() {
    try {
      widget.onBaseUrlChanged(_urlController.text.trim());
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('URL base actualizada correctamente')),
      );
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('URL inválida: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Configuración de Endpoint'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'URL Base del Backend Spring Boot (mobile:R4)',
            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
          ),
          const SizedBox(height: 8),
          const Text(
            'Permite cambiar de host local (localhost:8080) a la IP LAN de la laptop o emulador sin recompilar la app.',
            style: TextStyle(color: Colors.black54, fontSize: 13),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _urlController,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              labelText: 'URL Base',
              hintText: 'http://localhost:8080',
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              ActionChip(
                label: const Text('localhost:8080'),
                onPressed: () => setState(() => _urlController.text = 'http://localhost:8080'),
              ),
              ActionChip(
                label: const Text('10.0.2.2:8080 (Emulador)'),
                onPressed: () => setState(() => _urlController.text = 'http://10.0.2.2:8080'),
              ),
              ActionChip(
                label: const Text('192.168.0.147:8080 (LAN)'),
                onPressed: () => setState(() => _urlController.text = 'http://192.168.0.147:8080'),
              ),
            ],
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _saveUrl,
                  child: const Text('Guardar URL'),
                ),
              ),
              const SizedBox(width: 12),
              OutlinedButton(
                onPressed: _isTesting ? null : _testConnection,
                child: _isTesting
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Probar Conexión'),
              ),
            ],
          ),
          if (_testResult != null) ...[
            const SizedBox(height: 16),
            Card(
              color: _testResult!.startsWith('Conexión exitosa') ? Colors.green.shade50 : Colors.red.shade50,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  _testResult!,
                  style: TextStyle(
                    color: _testResult!.startsWith('Conexión exitosa') ? Colors.green.shade900 : Colors.red.shade900,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
