/// Demo entity Customer representing records from the generated backend.
/// Meets requirements for mobile:R2 (full CRUD cycle).
class Customer {
  final int? id;
  final String name;
  final String email;
  final bool active;

  Customer({
    this.id,
    required this.name,
    required this.email,
    this.active = true,
  });

  factory Customer.fromJson(Map<String, dynamic> json) {
    return Customer(
      id: json['id'] is int ? json['id'] as int : (json['id'] != null ? int.tryParse(json['id'].toString()) : null),
      name: json['name'] as String? ?? '',
      email: json['email'] as String? ?? '',
      active: json['active'] as bool? ?? true,
    );
  }

  Map<String, dynamic> toJson() {
    final map = <String, dynamic>{
      'name': name,
      'email': email,
      'active': active,
    };
    if (id != null) {
      map['id'] = id;
    }
    return map;
  }

  Customer copyWith({
    int? id,
    String? name,
    String? email,
    bool? active,
  }) {
    return Customer(
      id: id ?? this.id,
      name: name ?? this.name,
      email: email ?? this.email,
      active: active ?? this.active,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Customer &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          name == other.name &&
          email == other.email &&
          active == other.active;

  @override
  int get hashCode => id.hashCode ^ name.hashCode ^ email.hashCode ^ active.hashCode;

  @override
  String toString() => 'Customer(id: $id, name: $name, email: $email, active: $active)';
}
