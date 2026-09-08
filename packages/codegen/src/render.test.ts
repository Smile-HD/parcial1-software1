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
    // Order 0..* -- 0..* Product: lexicographic-owner rule makes Order the
    // owning ManyToMany side (documented in entity.hbs).
    expect(java).toContain('@ManyToMany');
    expect(java).toContain('@JoinTable');
    expect(java).toContain('private Set<Product> products');
  });

  it('renders the inverse ManyToMany side on Product with mappedBy', () => {
    const java = fileAt(`src/main/java/${PKG_PATH}/Product.java`);
    expect(java).toContain('@ManyToMany(mappedBy = "products", fetch = FetchType.EAGER)');
    expect(java).toContain('private Set<Order> orders');
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
    expect(java).toContain('repository.save');
    expect(java).toContain('repository.findAll');
    expect(java).toContain('repository.deleteById');
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
    expect(d.classes).toHaveLength(4);
    expect(d.associations).toHaveLength(3);
  });

  it('generates with the real renderer: zero warnings + expected file set', () => {
    const result = generate(goldenDiagram(), { outputRoot: ROOT, render });
    expect(result.warnings).toEqual([]);

    const paths = result.files.map((f) => f.path).sort();
    for (const name of ['Customer', 'Order', 'Product', 'ShippingAddress']) {
      expect(paths).toContain(`src/main/java/${PKG_PATH}/${name}.java`);
      expect(paths).toContain(`src/main/java/${PKG_PATH}/repository/${name}Repository.java`);
      expect(paths).toContain(`src/main/java/${PKG_PATH}/web/${name}Controller.java`);
    }
    expect(paths).toContain(`src/main/java/${PKG_PATH}/Application.java`);
    expect(paths).toContain('pom.xml');
    expect(paths).toContain('src/main/resources/application.properties');
    expect(paths).toContain('mvnw');
    expect(paths).toContain('mvnw.cmd');
    expect(paths).toContain('.mvn/wrapper/maven-wrapper.properties');
    expect(paths).toHaveLength(18);
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
