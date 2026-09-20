import { readFileSync } from 'node:fs';
import { DiagramSchema, type Diagram } from '@app/core';
import { describe, expect, it } from 'vitest';

import { generate, type EntityModel } from './generate.js';
import { createHandlebarsRenderer } from './render.js';

/**
 * Unit 14b renderer + template tests (offline — no Maven, no network).
 *
 * These assert that the Handlebars renderer resolves the template ids emitted
 * by the 14a file map and that the five Spring templates + the vendored Maven
 * wrapper assets produce the expected output for the golden diagram. The real
 * compile/start/CRUD proof is `tools/golden-check.mjs` (codegen:R5).
 */

const ROOT = '/tmp/job-golden';
const PKG = 'com.example.generated';
const PKG_PATH = PKG.replace(/\./g, '/');

const render = createHandlebarsRenderer();

function goldenDiagram(): Diagram {
  const raw = readFileSync(new URL('../../../golden/reference-diagram.json', import.meta.url), 'utf8');
  return DiagramSchema.parse(JSON.parse(raw));
}

function goldenFiles() {
  return generate(goldenDiagram(), { outputRoot: ROOT, render }).files;
}

function fileAt(path: string): string {
  const file = goldenFiles().find((f) => f.path === path);
  if (!file) throw new Error(`no generated file at ${path}`);
  return file.content;
}

describe('entity template', () => {
  it('renders a JPA entity with id, typed fields and relationship annotations', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Customer.java`);
    expect(java).toContain(`package ${PKG};`);
    expect(java).toContain('@Entity');
    expect(java).toContain('@Id');
    expect(java).toContain('@GeneratedValue(strategy = GenerationType.IDENTITY)');
    expect(java).toContain('private Long id;');
    expect(java).toContain('private String name;');
    expect(java).toContain('private Boolean active;');
    // Customer 1 -- 0..* Order => one-to-many collection, inverse side.
    expect(java).toContain('@OneToMany(mappedBy = "customer", fetch = FetchType.EAGER)');
    expect(java).toContain('@JsonIgnoreProperties("customer")');
    expect(java).toContain('private List<Order> orders');
    // Customer 1 -- 1 ShippingAddress => owning one-to-one with FK column.
    expect(java).toContain('@OneToOne');
    expect(java).toContain('@JoinColumn(name = "shipping_address_id")');
    expect(java).toContain('private ShippingAddress shippingAddress;');
    // Accessors exist for the generated fields.
    expect(java).toContain('public String getName()');
    expect(java).toContain('public void setName(String name)');

    // D11v2: applyFields static method for assistant CREATE/UPDATE
    expect(java).toContain('public static void applyFields(Customer entity, java.util.Map<String, String> fields)');
    expect(java).toContain('case "name", "nombre"');
    expect(java).toContain('case "active", "activo"');

    // D11v2: applyDefaults static method for partial CREATE Bean Validation compliance
    expect(java).toContain('public static void applyDefaults(Customer entity)');
    expect(java).toContain('entity.setName("Nuevo " + "Customer")');
    expect(java).toContain('entity.setActive(true)');

    // Human-readable toString instead of Object memory address
    expect(java).toContain('public String toString()');
    expect(java).toContain('return "Customer{"');
    expect(java).toContain('"id=" + getId()');
  });

  it('renders the owning ManyToOne on Order and imports java.time/java.math types', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Order.java`);
    // Quoted table name keeps the reserved SQL word ORDER valid.
    expect(java).toContain('@Table(name = "\\"Order\\"")');
    expect(java).toContain('@ManyToOne');
    expect(java).toContain('@JsonIgnoreProperties("orders")');
    expect(java).toContain('@JoinColumn(name = "customer_id")');
    expect(java).toContain('private Customer customer;');
    expect(java).toContain('import java.time.LocalDate;');
    expect(java).toContain('import java.math.BigDecimal;');
    expect(java).toContain('private LocalDate orderDate;');
    expect(java).toContain('private BigDecimal total;');
    expect(java).toContain('public static void applyDefaults(Order entity)');
    expect(java).toContain('entity.setTotal(java.math.BigDecimal.ZERO);');
    expect(java).toContain('entity.setOrderDate(java.time.LocalDate.now());');
    // Order 0..* -- 0..* Product: lexicographic-owner rule makes Order the
    // owning ManyToMany side (documented in entity.hbs).
    expect(java).toContain('@ManyToMany');
    expect(java).toContain('@JoinTable');
    expect(java).toContain('private Set<Product> products');
  });

  it('renders the inverse ManyToMany side on Product with mappedBy and robust assistant methods', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Product.java`);
    expect(java).toContain('@ManyToMany(mappedBy = "products", fetch = FetchType.EAGER)');
    expect(java).toContain('private Set<Order> orders');
    expect(java).toContain('public static void applyDefaults(Product entity)');
    expect(java).toContain('public static void applyFields(Product entity, java.util.Map<String, String> fields)');
  });

  it('renders the inverse OneToOne side on ShippingAddress with mappedBy', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/ShippingAddress.java`);
    expect(java).toContain('@OneToOne(mappedBy = "shippingAddress")');
    expect(java).toContain('private Customer customer;');
  });
});

describe('repository template', () => {
  it('extends JpaRepository with Long id', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/repository/CustomerRepository.java`);
    expect(java).toContain(`import ${PKG}.Customer;`);
    expect(java).toContain('import org.springframework.data.jpa.repository.JpaRepository;');
    expect(java).toContain('public interface CustomerRepository extends JpaRepository<Customer, Long>');
  });
});

describe('controller template (CRUD endpoints — codegen:R4)', () => {
  it('exposes all five required routes per entity', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/web/CustomerController.java`);
    expect(java).toContain('@RestController');
    expect(java).toContain('@RequestMapping("/api/customers")');
    expect(java).toContain('@PostMapping');
    expect(java).toContain('@GetMapping("/{id}")');
    expect(java).toContain('@GetMapping');
    expect(java).toContain('@PutMapping("/{id}")');
    expect(java).toContain('@DeleteMapping("/{id}")');
  });

  it('delegates to the service and never touches the repository (14c decision C)', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/web/CustomerController.java`);
    expect(java).toContain('CustomerService service');
    expect(java).toContain('service.save');
    expect(java).toContain('service.findAll');
    expect(java).toContain('service.findById');
    expect(java).toContain('service.deleteById');
    expect(java).not.toContain('Repository');
  });
});

describe('pom template', () => {
  it('pins Spring Boot parent, Java 21, web/jpa/h2 and the boot plugin', () => {
    const pom = fileAt('pom.xml');
    expect(pom).toContain('<artifactId>spring-boot-starter-parent</artifactId>');
    expect(pom).toContain('<java.version>21</java.version>');
    expect(pom).toContain('<artifactId>spring-boot-starter-web</artifactId>');
    expect(pom).toContain('<artifactId>spring-boot-starter-data-jpa</artifactId>');
    expect(pom).toContain('<artifactId>h2</artifactId>');
    expect(pom).toContain('<scope>runtime</scope>');
    expect(pom).toContain('<artifactId>spring-boot-maven-plugin</artifactId>');
  });
});

describe('application-properties template (design decision 10 — H2 file mode)', () => {
  it('configures an H2 file DB under ./data with ddl-auto=update', () => {
    const props = fileAt('src/main/resources/application.properties');
    expect(props).toContain('jdbc:h2:file:./data/');
    expect(props).toContain('org.h2.Driver');
    expect(props).toContain('spring.jpa.hibernate.ddl-auto=update');
    expect(props).toContain('server.port=8080');
  });
});

describe('maven-wrapper raw assets (vendored, never edited)', () => {
  it('serves the wrapper properties with the Maven 3.9.9 distributionUrl', () => {
    const props = render('maven-wrapper', { asset: 'maven-wrapper.properties' });
    expect(props).toContain(
      'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip',
    );
  });

  it('serves mvnw and mvnw.cmd verbatim (non-empty, recognizable scripts)', () => {
    const sh = render('maven-wrapper', { asset: 'mvnw' });
    const cmd = render('maven-wrapper', { asset: 'mvnw.cmd' });
    expect(sh).toContain('MAVEN_PROJECTBASEDIR');
    expect(cmd).toContain('@echo off');
  });
});

describe('golden reference diagram (codegen:R5 fixture)', () => {
  it('parses and validates against the core IR schema', () => {
    const d = goldenDiagram();
    expect(d.classes).toHaveLength(8);
    expect(d.associations).toHaveLength(4);
    expect(d.generalizations).toHaveLength(1);
    expect(d.realizations).toHaveLength(1);
    expect(d.naryAssociations).toHaveLength(1);
  });

  it('generates with the real renderer: expected warnings + file set', () => {
    const result = generate(goldenDiagram(), { outputRoot: ROOT, render });
    // 17 spec amendment (2026-09-13): the golden diagram has ONE abstract class
    // (Payment). Abstract classes emit the entity only — the CRUD trio would be
    // dead at runtime (Jackson/Spring Data cannot instantiate abstract types) —
    // and produce exactly this documented warning.
    expect(result.warnings.map((w) => w.code)).toEqual(['abstract-class-no-crud']);
    expect(result.warnings[0]?.element).toBe('Payment');

    const paths = result.files.map((f) => f.path).sort();
      for (const name of [
        'Customer',
        'Order',
        'Product',
        'ShippingAddress',
        'OrderLine',
        'Item',
        'CustomerOrderProductLink',
      ]) {
        expect(paths).toContain(`src/main/java/${PKG_PATH}/${name}.java`);
        expect(paths).toContain(`src/main/java/${PKG_PATH}/repository/${name}Repository.java`);
        expect(paths).toContain(`src/main/java/${PKG_PATH}/web/${name}Controller.java`);
        expect(paths).toContain(`src/main/java/${PKG_PATH}/service/${name}Service.java`);
      }
      // Abstract class (17 amendment): entity ONLY — no repository/controller/service.
      expect(paths).toContain(`src/main/java/${PKG_PATH}/Payment.java`);
      expect(paths.some((p) => p.includes('PaymentRepository'))).toBe(false);
      expect(paths.some((p) => p.includes('PaymentController'))).toBe(false);
      expect(paths.some((p) => p.includes('PaymentService'))).toBe(false);
    // Interface: plain file only — no repository/controller/service.
    expect(paths).toContain(`src/main/java/${PKG_PATH}/Sellable.java`);
    expect(paths.some((p) => p.includes('SellableRepository'))).toBe(false);
    expect(paths.some((p) => p.includes('SellableController'))).toBe(false);
    expect(paths.some((p) => p.includes('SellableService'))).toBe(false);
    expect(paths).toContain(`src/main/java/${PKG_PATH}/Application.java`);
    expect(paths).toContain('pom.xml');
    expect(paths).toContain('src/main/resources/application.properties');
    expect(paths).toContain('src/main/resources/application-prod.properties');
    expect(paths).toContain('mvnw');
    expect(paths).toContain('mvnw.cmd');
    expect(paths).toContain('.mvn/wrapper/maven-wrapper.properties');
    expect(paths).toContain('Dockerfile');
    expect(paths).toContain('docker-compose.yml');
    expect(paths).toContain('README.md');
    // 18: assistant files
    expect(paths).toContain(`src/main/java/${PKG_PATH}/assistant/AssistantEngine.java`);
    expect(paths).toContain(`src/main/java/${PKG_PATH}/assistant/IntentMatcher.java`);
    expect(paths).toContain(`src/main/java/${PKG_PATH}/assistant/OllamaEngine.java`);
    expect(paths).toContain(`src/main/java/${PKG_PATH}/assistant/AuditLog.java`);
    expect(paths).toContain(`src/main/java/${PKG_PATH}/assistant/OllamaProvisioner.java`);
    expect(paths).toContain(`src/main/java/${PKG_PATH}/web/AssistantController.java`);
    // 8 entities × 4 files + 1 interface + Application + pom + 2 properties
    // + 3 wrapper assets + Dockerfile + compose + README = 43.
    // 43 → 40: 17 amendment (2026-09-13) removes the CRUD trio for abstract Payment.
    // 40 → 45: 18 adds 5 assistant files (AssistantEngine, IntentMatcher,
    // OllamaEngine, AuditLog, AssistantController).
    // 45 → 46: D11v2 adds OllamaProvisioner.
    expect(paths).toHaveLength(46);
  });

  it('every generated file has non-stub content from a real template', () => {
    const result = generate(goldenDiagram(), { outputRoot: ROOT, render });
    for (const file of result.files) {
      expect(file.content).not.toContain('codegen plan stub');
      expect(file.content.length).toBeGreaterThan(10);
    }
  });

  it('entity models carry the mapped relationships used by the template', () => {
    const result = generate(goldenDiagram(), { outputRoot: ROOT, render });
    const customer = result.files.find(
      (f) => f.path === `src/main/java/${PKG_PATH}/Customer.java`,
    )!.model as EntityModel;
    expect(customer.relationships.map((r) => r.kind).sort()).toEqual([
      'OneToMany',
      'OneToOne',
    ]);
  });
});

// ---------- unit 14c: UML v2 mappings in the rendered Java (task 14.5) ----------

describe('composition cascade (14.5)', () => {
  it('Order ◆— OrderLine renders cascade=ALL + orphanRemoval on the container collection', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Order.java`);
    expect(java).toContain(
      '@OneToMany(mappedBy = "order", fetch = FetchType.EAGER, cascade = CascadeType.ALL, orphanRemoval = true)',
    );
    expect(java).toContain('private List<OrderLine> orderLines');
    // The child side stays a plain owning ManyToOne (no back-cascade).
    const line = fileAt(`src/main/java/${PKG_PATH}/OrderLine.java`);
    expect(line).toContain('@ManyToOne');
    expect(line).not.toMatch(/@ManyToOne\s*\(/);
    expect(line).not.toMatch(/@OneToMany[^)]*orphanRemoval/);
  });
});

describe('generalization → single-table inheritance (14.5)', () => {
  it('root Item declares @Inheritance + @DiscriminatorColumn', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Item.java`);
    expect(java).toContain('@Inheritance(strategy = InheritanceType.SINGLE_TABLE)');
    expect(java).toContain('@DiscriminatorColumn(name = "DTYPE")');
    expect(java).toContain('public class Item {');
  });

  it('Product extends Item + implements Sellable without redeclaring inherited fields', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Product.java`);
    expect(java).toContain('public class Product extends Item implements Sellable {');
    // Subclasses carry no @Table annotation — the root's single table stores
    // the whole hierarchy (asserted on the annotation, not the doc comment).
    expect(java).not.toContain('@Table(name');
    expect(java).toContain('private BigDecimal price;');
    expect(java).not.toContain('label'); // Item's field must not be redeclared
  });
});

describe('interface classifier (14.5)', () => {
  it('Sellable renders as a plain Java interface with method signatures', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Sellable.java`);
    expect(java).toContain(`package ${PKG};`);
    expect(java).toContain('public interface Sellable {');
    expect(java).toContain('BigDecimal getPrice();');
    expect(java).toContain('import java.math.BigDecimal;');
    expect(java).not.toContain('@Entity');
  });

  it('entity implementing an interface generates stub implementations for interface methods with correct return defaults and imports', () => {
    const d: Diagram = {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Interface Method Contract Test',
      classes: [
        {
          id: '11111111-1111-4111-8111-000000000001',
          name: 'Payment',
          position: { x: 100, y: 100 },
          kind: 'class',
          isAbstract: false,
          attributes: [],
          methods: [],
        },
        {
          id: '11111111-1111-4111-8111-000000000002',
          name: 'Payable',
          position: { x: 300, y: 100 },
          kind: 'interface',
          isAbstract: true,
          attributes: [],
          methods: [
            {
              id: '11111111-1111-4111-8111-000000000003',
              name: 'processPayment',
              returnType: 'Boolean',
              parameters: [{ name: 'amount', type: 'BigDecimal' }],
            },
          ],
        },
      ],
      associations: [],
      generalizations: [],
      realizations: [
        {
          id: '11111111-1111-4111-8111-000000000004',
          clientClassId: '11111111-1111-4111-8111-000000000001',
          supplierInterfaceId: '11111111-1111-4111-8111-000000000002',
        },
      ],
      dependencies: [],
      naryAssociations: [],
    };

    const res = generate(d, { outputRoot: ROOT, render });
    const paymentFile = res.files.find((f) => f.path.endsWith('Payment.java'))!;
    expect(paymentFile).toBeDefined();
    expect(paymentFile.content).toContain('public class Payment implements Payable {');
    expect(paymentFile.content).toContain('@Override');
    expect(paymentFile.content).toContain('public Boolean processPayment(BigDecimal amount) {');
    expect(paymentFile.content).toContain('return false;');
    expect(paymentFile.content).toContain('import java.math.BigDecimal;');
  });
});

describe('abstract class entity (14.5)', () => {
  it('Payment renders as an abstract JPA entity', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Payment.java`);
    expect(java).toContain('@Entity');
    expect(java).toContain('public abstract class Payment {');
  });
});

describe('member visibility + attribute multiplicity (14.5)', () => {
  it('renders private/protected field modifiers from -/# visibility', () => {
    expect(fileAt(`src/main/java/${PKG_PATH}/Order.java`)).toContain('private String note;');
    expect(fileAt(`src/main/java/${PKG_PATH}/Product.java`)).toContain('protected String category;');
  });

  it('renders a many-valued basic attribute as @ElementCollection List<T>', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Customer.java`);
    expect(java).toContain('@ElementCollection');
    expect(java).toContain('private List<String> nicknames = new ArrayList<>();');
    expect(java).toContain('public List<String> getNicknames()');
  });
});

describe('n-ary join entity (14.5)', () => {
  it('CustomerOrderProductLink carries one owning @ManyToOne per member', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/CustomerOrderProductLink.java`);
    expect(java).toContain('@Entity');
    for (const [decl, column] of [
      ['private Customer customer;', 'customer_id'],
      ['private Order order;', 'order_id'],
      ['private Product product;', 'product_id'],
    ]) {
      expect(java).toContain(`@JoinColumn(name = "${column}")`);
      expect(java).toContain(decl);
    }
    expect(java).toContain('public class CustomerOrderProductLink {');
  });
});

describe('service template (maintainer decision C — thin 3+1 service layer)', () => {
  it('renders a @Service with repository injection and the four pass-through methods', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/service/CustomerService.java`);
    expect(java).toContain(`package ${PKG}.service;`);
    expect(java).toContain('import jakarta.persistence.EntityNotFoundException;');
    expect(java).toContain('@Service');
    expect(java).toContain('public CustomerService(CustomerRepository repository)');
    expect(java).toContain('public List<Customer> findAll()');
    expect(java).toContain('public Customer findById(Long id)');
    expect(java).toContain('new EntityNotFoundException(');
    expect(java).toContain('public Customer save(Customer entity)');
    expect(java).toContain('public void deleteById(Long id)');
  });
});

// ---------- unit 18: offline assistant (design D11) ----------

describe('assistant templates (18.1)', () => {
  it('AssistantEngine.java is a valid interface with Intent inner record', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/assistant/AssistantEngine.java`);
    expect(java).toContain(`package ${PKG}.assistant;`);
    expect(java).toContain('public interface AssistantEngine');
    expect(java).toContain('Optional<Intent> classify(String freeText)');
    expect(java).toContain('record Intent');
    expect(java).toContain('enum Action');
    expect(java).toContain('LIST');
    expect(java).toContain('COUNT');
    expect(java).toContain('CREATE');
    expect(java).toContain('DELETE');
    expect(java).toContain('UPDATE');
    expect(java).toContain('Long id');
    expect(java).toContain('Map<String, String> fields');
  });

  it('IntentMatcher.java has bilingual action keywords and entity matching (D11v2)', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/assistant/IntentMatcher.java`);
    expect(java).toContain('public class IntentMatcher');
    // English keywords (LIST, COUNT, CREATE + D11v2: DELETE, UPDATE)
    expect(java).toContain('"list"');
    expect(java).toContain('"count"');
    expect(java).toContain('"create"');
    expect(java).toContain('"delete"');
    expect(java).toContain('"update"');
    // Spanish keywords
    expect(java).toContain('"lista"');
    expect(java).toContain('"crea"');
    expect(java).toContain('"elimina"');
    expect(java).toContain('"modifica"');
    // D11v2: hardcoded SPANISH_ENTITIES removed — dynamic matching via knownEntities
    // ID extraction via regex
    expect(java).toContain('ID_PATTERN');
  });

  it('OllamaEngine.java uses noProxy and has loopback guard', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/assistant/OllamaEngine.java`);
    expect(java).toContain('public class OllamaEngine implements AssistantEngine');
    expect(java).toContain('NO_PROXIES');
    expect(java).toContain('Proxy.NO_PROXY');
    expect(java).toContain('127.0.0.1');
    expect(java).toContain('localhost');
    expect(java).toContain('assistant:R1');
    expect(java).toContain('matchKnownEntity');
    expect(java).toContain('extractJsonContent');
    expect(java).toContain('c.startsWith("product")');
  });

  it('AuditLog.java appends ISO-timestamped lines with SHA-256', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/assistant/AuditLog.java`);
    expect(java).toContain('public class AuditLog');
    expect(java).toContain('assistant-audit.log');
    expect(java).toContain('SHA-256');
    expect(java).toContain('Instant.now()');
  });

  it('OllamaProvisioner.java auto-provisions Ollama and checks model readiness (D11v2)', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/assistant/OllamaProvisioner.java`);
    expect(java).toContain('public class OllamaProvisioner');
    expect(java).toContain('@PostConstruct');
    expect(java).toContain('isOllamaAvailable()');
    expect(java).toContain('isModelReady()');
    expect(java).toContain('checkHealth()');
    expect(java).toContain('checkModel()');
    expect(java).toContain('pullModel()');
  });

  it('AssistantController.java dispatches to entity services and audits', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/web/AssistantController.java`);
    expect(java).toContain('@RestController');
    expect(java).toContain('@RequestMapping("/api/assistant")');
    expect(java).toContain('@PostMapping');
    expect(java).toContain('@GetMapping("/status")');
    expect(java).toContain('public StatusResponse status()');
    expect(java).toContain('AssistantRequest');
    expect(java).toContain('AssistantResponse');
    expect(java).toContain('CAPABILITY_MESSAGE');
    expect(java).toContain('applyFields');
    expect(java).toContain('applyDefaults');
    expect(java).toContain('deleteEntity');
    expect(java).toContain('updateEntity');
    expect(java).toContain('createEntity');
    // Imports every concrete entity service
    expect(java).toContain('CustomerService');
    expect(java).toContain('OrderService');
    expect(java).toContain(' ProductService');
    expect(java).toContain('ShippingAddressService');
    expect(java).toContain('OrderLineService');
    expect(java).toContain('ItemService');
    expect(java).toContain('CustomerOrderProductLinkService');
  });
});

describe('application-properties includes assistant config (18.1)', () => {
  it('configures assistant.model and assistant.ollama.url', () => {
    const props = fileAt('src/main/resources/application.properties');
    expect(props).toContain('assistant.model=qwen2.5:1.5b');
    expect(props).toContain('assistant.ollama.url=http://127.0.0.1:11434');
    expect(props).toContain('assistant.auto-pull=false');
  });
});

describe('production profile + zip extras (14.6b + maintainer decision D)', () => {
  it('application-prod.properties wires PostgreSQL purely through env vars', () => {
    const props = fileAt('src/main/resources/application-prod.properties');
    expect(props).toContain('spring.datasource.url=${SPRING_DATASOURCE_URL}');
    expect(props).toContain('spring.datasource.username=${SPRING_DATASOURCE_USERNAME}');
    expect(props).toContain('spring.datasource.password=${SPRING_DATASOURCE_PASSWORD}');
    expect(props).toContain('org.postgresql.Driver');
    // Nothing hardcoded: no literal jdbc url, user or password value
    // (env-var placeholders start with `$`, so `[^$]` catches literals only).
    expect(props).not.toMatch(/jdbc:postgresql:\/\//);
    expect(props).not.toMatch(/password=[^$]/);
  });

  it('pom adds the PostgreSQL driver at runtime scope', () => {
    const pom = fileAt('pom.xml');
    expect(pom).toContain('<artifactId>postgresql</artifactId>');
  });

  it('Dockerfile runs the boot jar on a 21 JRE alpine image', () => {
    const docker = fileAt('Dockerfile');
    expect(docker).toContain('FROM eclipse-temurin:21-jre-alpine');
    expect(docker).toContain('target/*.jar');
    expect(docker).toContain('ENTRYPOINT');
  });

  it('docker-compose wires app (prod profile) to postgres:16-alpine with a volume', () => {
    const compose = fileAt('docker-compose.yml');
    expect(compose).toContain('build: .');
    expect(compose).toContain('SPRING_PROFILES_ACTIVE: prod');
    expect(compose).toContain('jdbc:postgresql://db:5432/');
    expect(compose).toContain('image: postgres:16-alpine');
    expect(compose).toContain('volumes:');
    // D11v2: connects to host Ollama via host.docker.internal
    expect(compose).toContain('http://host.docker.internal:11434');
    expect(compose).toContain('host.docker.internal:host-gateway');
  });

  it('README documents local run, prod run and the AWS deploy path', () => {
    const readme = fileAt('README.md');
    expect(readme).toContain('./mvnw spring-boot:run');
    expect(readme).toContain('SPRING_PROFILES_ACTIVE=prod');
    expect(readme).toContain('EC2');
    expect(readme).toContain('RDS');
  });
});

describe('rendering entities with normalized informal names', () => {
  it('renders valid Java code for classes and fields with spaces, accents and leading digits', () => {
    const customDiagram = DiagramSchema.parse({
      id: '99999999-9999-4999-8999-999999999999',
      name: 'Informal Diagram',
      classes: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          name: 'Customer Order',
          kind: 'class',
          isAbstract: false,
          position: { x: 0, y: 0 },
          attributes: [
            { id: '11111111-1111-4111-8111-111111111111', name: 'Phone number', type: 'String', visibility: '+', isStatic: false, isDerived: false },
            { id: '22222222-2222-4222-8222-222222222222', name: 'dirección de envío', type: 'String', visibility: '+', isStatic: false, isDerived: false },
            { id: '33333333-3333-4333-8333-333333333333', name: '123code', type: 'Integer', visibility: '+', isStatic: false, isDerived: false },
          ],
          methods: [],
        },
      ],
      associations: [],
    });

    const files = generate(customDiagram, { outputRoot: ROOT, render }).files;
    const entityFile = files.find((f) => f.path === `src/main/java/${PKG_PATH}/CustomerOrder.java`);
    expect(entityFile).toBeDefined();
    expect(entityFile?.content).toContain('public class CustomerOrder');
    expect(entityFile?.content).toContain('private String phoneNumber;');
    expect(entityFile?.content).toContain('public String getPhoneNumber()');
    expect(entityFile?.content).toContain('public void setPhoneNumber(String phoneNumber)');
    expect(entityFile?.content).toContain('private String direccionDeEnvio;');
    expect(entityFile?.content).toContain('private Integer _123code;');

    const repoFile = files.find((f) => f.path === `src/main/java/${PKG_PATH}/repository/CustomerOrderRepository.java`);
    expect(repoFile).toBeDefined();
    expect(repoFile?.content).toContain('public interface CustomerOrderRepository extends JpaRepository<CustomerOrder, Long>');

    const serviceFile = files.find((f) => f.path === `src/main/java/${PKG_PATH}/service/CustomerOrderService.java`);
    expect(serviceFile).toBeDefined();
    expect(serviceFile?.content).toContain('public class CustomerOrderService');

    const controllerFile = files.find((f) => f.path === `src/main/java/${PKG_PATH}/web/CustomerOrderController.java`);
    expect(controllerFile).toBeDefined();
    expect(controllerFile?.content).toContain('public class CustomerOrderController');

    // Robust applyFields & applyDefaults on custom entity
    expect(entityFile?.content).toContain('public static void applyFields(CustomerOrder entity, java.util.Map<String, String> fields)');
    expect(entityFile?.content).toContain('public static void applyDefaults(CustomerOrder entity)');
    expect(entityFile?.content).toContain('entity.set_123code(0);');
    expect(entityFile?.content).toContain('entity.setPhoneNumber("-");');
    expect(entityFile?.content).toContain('k.contains("phonenumber")');
  });
});

