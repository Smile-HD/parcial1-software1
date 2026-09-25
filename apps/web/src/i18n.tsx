/**
 * unidad 13e.11 — i18n: Cadenas de UI en inglés/español con alternador de idioma en vivo.
 *
 * Diseño (deliberadamente reducido):
 *  - Un diccionario plano indexado por id de cadena; `en` es la fuente de verdad y
 *    `es` está tipado como `Record<TKey, string>` para que una traducción faltante sea un
 *    error de COMPILACIÓN, no un fallback en tiempo de ejecución.
 *  - Un pequeño almacén externo (estado de módulo + conjunto de listeners) sincronizado con
 *    `localStorage` bajo STORAGE_KEY. El valor por defecto es inglés.
 *  - `t(key, params)` es utilizable FUERA de los componentes (constructores de mensajes de guardas,
 *    manejadores de eventos) y lee el idioma actual al momento de la llamada.
 *  - `useT()` suscribe el componente invocador a cambios de idioma mediante
 *    `useSyncExternalStore`, por lo que alternarlo vuelve a renderizar cada cadena en vivo.
 *  - `LanguageToggle` es el control segmentado visible EN/ES utilizado en la
 *    barra de herramientas de la aplicación.
 *
 * El texto en español es español neutro/profesional latinoamericano (registro de UI de
 * producto — sin modismos regionales). El título de la aplicación permanece como "UML Design Tool" en
 * ambos idiomas (13e.8).
 */
import { useSyncExternalStore, type ReactElement } from 'react';

export type Lang = 'en' | 'es';

/** Clave de localStorage que almacena la elección de idioma del usuario. */
export const LANG_STORAGE_KEY = 'uml-design-tool-lang';

/** Todas las cadenas de interfaz de usuario de cara al usuario, inglés (fuente de verdad). */
const EN = {
  // Shell de la aplicación (13e.8: el título no lleva "AI" y es idéntico en ambos idiomas).
  'app.title': 'UML Design Tool',
  'app.loading': 'Loading…',
  'app.loadError': 'Failed to load the diagram',
  'app.apiConnectFailed': 'Failed to connect to the API',
  'app.saveRetryExhausted': 'Could not save: the diagram kept changing on the server',
  'toolbar.save': 'Save',
  'toolbar.saving': 'Saving…',
  'toolbar.saved': 'Saved',
  'toolbar.share': 'Share',
  'toolbar.copied': 'Copied!',
  'toolbar.shareTitle': 'Copy diagram URL to clipboard',
  'toolbar.language': 'Language',
  'codegen.button': 'Generate Spring',
  'codegen.ariaLabel': 'Generate Spring Boot backend from this diagram',
  'codegen.queued': 'Queued…',
  'codegen.running': 'Generating…',
  'codegen.succeeded': 'Downloaded',
  'codegen.startFailed': 'Failed to start code generation',
  'codegen.pollFailed': 'Lost connection to the generation service',
  'codegen.downloadFailed': 'Generation finished but the artifact could not be downloaded',
  'codegen.unknownError': 'Generation failed for an unknown reason',
  'xmi.button': 'Import XMI',
  'xmi.ariaLabel': 'Import an Enterprise Architect XMI 2.1 file',
  'xmi.reading': 'Reading…',
  'xmi.importing': 'Importing…',
  'xmi.succeeded': 'Imported',
  'xmi.readFailed': 'Failed to read the XMI file',
  'xmi.requestFailed': 'Failed to reach the import service',
  'xmi.applyFailed': 'Imported {applied} elements before a delta was rejected ({kind})',
  'xmi.noClassesFound': 'No classes found in XMI file',
  'xmi.exportButton': 'Export XMI',
  'xmi.exportAriaLabel': 'Export diagram as an Enterprise Architect XMI 2.1 file',
  'xmi.exporting': 'Exporting…',
  'xmi.exportSucceeded': 'Exported',
  'xmi.exportFailed': 'Failed to export XMI file',


  // Importación de fotos (PR 16, tarea 16.3-WEB).
  'photo.button': 'Import Photo',
  'photo.ariaLabel': 'Import a photo of a class diagram',
  'photo.validating': 'Validating…',
  'photo.uploading': 'Uploading…',
  'photo.extracting': 'Extracting…',
  'photo.applying': 'Applying…',
  'photo.succeeded': 'Applied',
  'photo.readFailed': 'Failed to read the image file',
  'photo.uploadFailed': 'Failed to reach the photo import service',
  'photo.pollFailed': 'Lost connection to the extraction service',
  'photo.extractionFailed': 'Photo extraction failed',
  'photo.noBatch': 'Photo extraction did not return a result',
  'photo.applySchemaError': 'The extracted result is invalid and cannot be applied',
  'photo.applyFailed': 'Applied 0 elements before a delta was rejected ({kind})',

  // Exportación de imágenes (unidad 16b).
  'export.png': 'Export PNG',
  'export.pngAria': 'Export diagram as PNG image',
  'export.jpeg': 'Export JPEG',
  'export.jpegAria': 'Export diagram as JPEG image',
  'export.emptyWarning': 'No diagram content to export',
  'export.previewTitle': 'Export Preview',
  'export.previewSubtitle': 'Review the generated diagram image before downloading',
  'export.download': 'Download Image',
  'export.cancel': 'Cancel',
  'export.dimensions': 'Dimensions',
  'export.format': 'Format',
  'export.close': 'Close',
  'export.closeAria': 'Close preview modal',

  // Barra del intérprete.
  'interpreter.ariaLabel': 'Natural language command',
  'interpreter.placeholder': 'e.g. "add a class Product"',
  'interpreter.send': 'Send',
  'interpreter.record': 'Record',
  'interpreter.stop': 'Stop',
  'interpreter.recordAria': 'Record voice command',
  'interpreter.stopAria': 'Stop voice command',
  'interpreter.thinking': 'Thinking…',
  'interpreter.refused': 'Refused: {reason}',
  'interpreter.reachFailed': 'Failed to reach the interpreter',
  'interpreter.confirmFailed': 'Failed to confirm the change',
  'interpreter.discardFailed': 'Failed to discard the change',
  'interpreter.applyFailed': 'The confirmed change could not be applied ({kind})',
  'voice.micUnavailable': 'Microphone unavailable',
  'voice.sttFailed': 'Failed to reach the speech-to-text service',
  'voice.recordingFailed': 'Recording failed',

  // Modal de vista previa de delta.
  'preview.ariaLabel': 'AI change preview',
  'preview.heading': 'AI proposes this change',
  'preview.confirm': 'Confirm',
  'preview.reject': 'Reject',

  // Presencia.
  'presence.onlineUsers': 'Online users',

  // Caja de herramientas (Paleta).
  'toolbox.header': 'Toolbox',
  'toolbox.objects': 'Objects',
  'toolbox.relations': 'Relations',
  'toolbox.ariaLabel': 'UML element palette',
  'toolbox.collapse': 'Collapse toolbox',
  'toolbox.expand': 'Expand toolbox',
  'tool.class': 'Class',
  'tool.interface': 'Interface',
  'tool.association': 'Association',
  'tool.associationClass': 'Association Class',
  'tool.aggregation': 'Aggregation',
  'tool.composition': 'Composition',
  'tool.generalization': 'Generalization',
  'tool.realization': 'Realization',
  'tool.dependency': 'Dependency',
  'tool.nary': 'N-ary',
  'palette.createClassAria': 'Create class (drag onto canvas)',
  'palette.createInterfaceAria': 'Create interface (drag onto canvas)',
  'palette.edgeToolAria': '{label} edge tool',
  'palette.naryAria': 'N-ary association tool (pick 3 or more classes)',
  'palette.dragClassTitle': 'Drag onto the canvas to create a class',
  'palette.dragInterfaceTitle': 'Drag onto the canvas to create an interface',
  'palette.armToolTitle': 'Click, then drag between two classes to create a {label}',
  'palette.naryTitle': 'Click, then pick at least three classes',

  // Barra de herramientas del lienzo.
  'canvas.addClass': 'Add class',
  'canvas.addInterface': 'Add interface',
  'canvas.linkClasses': 'Link classes',
  'canvas.cancelLink': 'Cancel link',
  'canvas.naryAssociation': 'N-ary association',
  'canvas.cancelNary': 'Cancel n-ary',
  'canvas.directed': 'Directed',
  'canvas.selectTarget': 'Select target class',
  'canvas.edgeToolHint': '{tool} tool armed — drag from a source class to a target class. Press Esc to cancel.',
  'canvas.pageBoundary': 'Diagram Page',
  'canvas.zoomControls': 'Zoom controls',
  'canvas.zoomIn': 'Zoom in (last click)',
  'canvas.zoomOut': 'Zoom out (last click)',
  'canvas.zoomReset': 'Fit view',
  'canvas.zoomLevel': 'Current zoom level',

  // Panel de selección N-aria.
  'nary.panelTitle': 'N-ary association — {n} of 3+ classes selected',
  'nary.multiplicityFor': 'Multiplicity for {name}',
  'nary.name': 'Name',
  'nary.nameAria': 'N-ary association name',
  'nary.optional': 'optional',
  'nary.create': 'Create',
  'nary.createAria': 'Create n-ary association',

  // Editor unificado de aristas.
  'editor.associationName': 'Association name',
  'editor.label': 'Label',
  'editor.labelAria': '{type} label',
  'editor.sourceRole': 'Source role',
  'editor.targetRole': 'Target role',
  'editor.sourceMultiplicity': 'Source multiplicity',
  'editor.targetMultiplicity': 'Target multiplicity',
  'editor.diamondEnd': 'Diamond end: {end}',
  'editor.endSource': 'Source',
  'editor.endTarget': 'Target',
  'editor.flipDiamondEnd': 'Flip diamond end',
  'editor.flipDiamondEndAria': 'Flip diamond end to {end}',
  'editor.associationClass': 'Association class',
  'editor.noAssociationClass': '(None)',
  'editor.delete': 'Delete {type}',
  'editor.deleteAria': 'Delete {type} {id}',
  'editor.close': 'Close',
  'editor.closeAria': 'Close edge editor',

  // Editor del diamante N-ario.
  'naryEditor.title': 'N-ary association',
  'naryEditor.nameAria': 'N-ary name',
  'naryEditor.endMultiplicityAria': 'N-ary end multiplicity for {name}',
  'naryEditor.delete': 'Delete n-ary association',
  'naryEditor.deleteAria': 'Delete n-ary association {id}',
  'naryEditor.closeAria': 'Close n-ary editor',

  // Paneles de relaciones por clase.
  'panel.generalizationsFor': 'Generalizations for {name}',
  'panel.realizationsFor': 'Realizations for {name}',
  'panel.dependenciesFor': 'Dependencies for {name}',
  'panel.none': 'None',
  'panel.inheritsFrom': 'Inherits from {name}',
  'panel.inheritedBy': 'Inherited by {name}',
  'panel.realizes': 'Realizes {name}',
  'panel.realizedBy': 'Realized by {name}',
  'panel.dependsOn': 'Depends on {name}',
  'panel.dependencyFrom': 'Dependency from {name}',
  'panel.removeInheritance': 'Remove inheritance',
  'panel.removeInheritanceAria': 'Delete generalization {id}',
  'panel.removeRealization': 'Remove realization',
  'panel.removeRealizationAria': 'Delete realization {id}',
  'panel.removeDependency': 'Remove dependency',
  'panel.removeDependencyAria': 'Delete dependency {id}',

  // Guardas de conexión / rechazos del motor.
  'guard.bothEndsClasses': 'Both ends of the connection must be classes.',
  'guard.endpointsExist': 'Both endpoints must be existing classes.',
  'guard.invalidEndpoints': '{label} rejected: invalid endpoints.',
  'guard.rejectedReason': '{label} rejected: {reason}.',
  'guard.noSelfInheritance': 'A class cannot inherit from itself.',
  'guard.realizationTarget': 'A realization must target an interface («interface»).',
  'reason.cycle': 'this inheritance would create a cycle',
  'reason.duplicateGeneralization': 'this inheritance link already exists',
  'reason.realizationNotInterface': 'the target must be an interface',
  'reason.duplicateRealization': 'this realization already exists',
  'reason.duplicateDependency': 'this dependency already exists',
  'reason.classNotFound': 'a referenced class does not exist',
  'reason.unknown': 'the model rejected the change and is unchanged',

  // Nodo de clase (menú contextual + edición de miembros).
  'node.deleteAria': 'Delete {name}',
  'node.noOtherClasses': 'No other classes',
  'node.makeSubclassOf': 'Make subclass of {name}',
  'node.realize': 'Realize {name}',
  'node.markAbstract': 'Mark abstract',
  'node.unmarkAbstract': 'Unmark abstract',
  'node.close': 'Close',
  'node.closeMenuAria': 'Close context menu',
  'node.attrNameRequired': 'Attribute name is required',
  'node.methodNameRequired': 'Method name is required',
  'node.nameTypeRequired': 'Name and type are required',
  'node.phName': 'name',
  'node.phType': 'type',
  'node.phReturnType': 'return type',
  'node.phParams': 'param: type, ...',
  'node.static': 'static',
  'node.derived': 'derived',
  'node.attrVisibilityAria': 'Attribute visibility',
  'node.attrNameAria': 'Attribute name',
  'node.attrTypeAria': 'Attribute type',
  'node.attrMultiplicityAria': 'Attribute multiplicity',
  'node.attrStaticAria': 'Attribute static',
  'node.attrDerivedAria': 'Attribute derived',
  'node.addAttrAria': 'Add attribute',
  'node.methodVisibilityAria': 'Method visibility',
  'node.methodNameAria': 'Method name',
  'node.methodReturnTypeAria': 'Method return type',
  'node.methodParamsAria': 'Method parameters',
  'node.methodStaticAria': 'Method static',
  'node.addMethodAria': 'Add method',
  'node.editAttrNameAria': 'Edit attribute name',
  'node.editAttrTypeAria': 'Edit attribute type',
  'node.editMethodNameAria': 'Edit method name',
  'node.editMethodReturnTypeAria': 'Edit method return type',
  'node.editMethodParamsAria': 'Edit method parameters',
  'node.confirmEditAria': 'Confirm edit',
  'node.cancelEditAria': 'Cancel edit',
  'node.editAttrAria': 'Edit attribute {name}',
  'node.removeAttrAria': 'Remove attribute {name}',
  'node.editMethodAria': 'Edit method {name}',
  'node.removeMethodAria': 'Remove method {name}',
  'node.quickLinkerTitle': 'Drag to another element to link, or to empty canvas to create and link',
} as const;

export type TKey = keyof typeof EN;

/** Español — registro de UI de producto neutro/profesional (sin modismos regionales). */
const ES: Record<TKey, string> = {
  'app.title': 'UML Design Tool',
  'app.loading': 'Cargando…',
  'app.loadError': 'No se pudo cargar el diagrama',
  'app.apiConnectFailed': 'No se pudo conectar con la API',
  'app.saveRetryExhausted': 'No se pudo guardar: el diagrama siguió cambiando en el servidor',
  'toolbar.save': 'Guardar',
  'toolbar.saving': 'Guardando…',
  'toolbar.saved': 'Guardado',
  'toolbar.share': 'Compartir',
  'toolbar.copied': '¡Copiado!',
  'toolbar.shareTitle': 'Copiar URL del diagrama al portapapeles',
  'toolbar.language': 'Idioma',
  'codegen.button': 'Generar Spring',
  'codegen.ariaLabel': 'Generar backend Spring Boot a partir de este diagrama',
  'codegen.queued': 'En cola…',
  'codegen.running': 'Generando…',
  'codegen.succeeded': 'Descargado',
  'codegen.startFailed': 'No se pudo iniciar la generación de código',
  'codegen.pollFailed': 'Se perdió la conexión con el servicio de generación',
  'codegen.downloadFailed': 'La generación terminó pero no se pudo descargar el artefacto',
  'codegen.unknownError': 'La generación falló por una razón desconocida',
  'xmi.button': 'Importar XMI',
  'xmi.ariaLabel': 'Importar un archivo XMI 2.1 de Enterprise Architect',
  'xmi.reading': 'Leyendo…',
  'xmi.importing': 'Importando…',
  'xmi.succeeded': 'Importado',
  'xmi.readFailed': 'No se pudo leer el archivo XMI',
  'xmi.requestFailed': 'No se pudo contactar al servicio de importación',
  'xmi.applyFailed': 'Se importaron {applied} elementos antes de rechazar un delta ({kind})',
  'xmi.noClassesFound': 'No se encontraron clases en el archivo XMI',
  'xmi.exportButton': 'Exportar XMI',
  'xmi.exportAriaLabel': 'Exportar diagrama como archivo XMI 2.1 de Enterprise Architect',
  'xmi.exporting': 'Exportando…',
  'xmi.exportSucceeded': 'Exportado',
  'xmi.exportFailed': 'No se pudo exportar el archivo XMI',


  // Importación de fotos (PR 16, tarea 16.3-WEB).
  'photo.button': 'Importar Foto',
  'photo.ariaLabel': 'Importar una foto de un diagrama de clases',
  'photo.validating': 'Validando…',
  'photo.uploading': 'Subiendo…',
  'photo.extracting': 'Extrayendo…',
  'photo.applying': 'Aplicando…',
  'photo.succeeded': 'Aplicado',
  'photo.readFailed': 'No se pudo leer el archivo de imagen',
  'photo.uploadFailed': 'No se pudo contactar al servicio de importación de fotos',
  'photo.pollFailed': 'Se perdió la conexión con el servicio de extracción',
  'photo.extractionFailed': 'La extracción de la foto falló',
  'photo.noBatch': 'La extracción de la foto no devolvió un resultado',
  'photo.applySchemaError': 'El resultado extraído no es válido y no se puede aplicar',
  'photo.applyFailed': 'Se aplicaron 0 elementos antes de rechazar un delta ({kind})',

  // Exportación de imágenes (unidad 16b).
  'export.png': 'Exportar PNG',
  'export.pngAria': 'Exportar diagrama como imagen PNG',
  'export.jpeg': 'Exportar JPEG',
  'export.jpegAria': 'Exportar diagrama como imagen JPEG',
  'export.emptyWarning': 'No hay contenido del diagrama para exportar',
  'export.previewTitle': 'Vista Previa de Exportación',
  'export.previewSubtitle': 'Revisá la imagen generada del diagrama antes de descargarla',
  'export.download': 'Descargar Imagen',
  'export.cancel': 'Cancelar',
  'export.dimensions': 'Dimensiones',
  'export.format': 'Formato',
  'export.close': 'Cerrar',
  'export.closeAria': 'Cerrar vista previa',

  'interpreter.ariaLabel': 'Comando en lenguaje natural',
  'interpreter.placeholder': 'p. ej. "agregar una clase Producto"',
  'interpreter.send': 'Enviar',
  'interpreter.record': 'Grabar',
  'interpreter.stop': 'Detener',
  'interpreter.recordAria': 'Grabar comando de voz',
  'interpreter.stopAria': 'Detener comando de voz',
  'interpreter.thinking': 'Pensando…',
  'interpreter.refused': 'Rechazado: {reason}',
  'interpreter.reachFailed': 'No se pudo contactar con el intérprete',
  'interpreter.confirmFailed': 'No se pudo confirmar el cambio',
  'interpreter.discardFailed': 'No se pudo descartar el cambio',
  'interpreter.applyFailed': 'El cambio confirmado no se pudo aplicar ({kind})',
  'voice.micUnavailable': 'Micrófono no disponible',
  'voice.sttFailed': 'No se pudo contactar con el servicio de voz a texto',
  'voice.recordingFailed': 'Error al grabar',

  'preview.ariaLabel': 'Vista previa del cambio de la IA',
  'preview.heading': 'La IA propone este cambio',
  'preview.confirm': 'Confirmar',
  'preview.reject': 'Rechazar',

  'presence.onlineUsers': 'Usuarios en línea',

  'toolbox.header': 'Caja de herramientas',
  'toolbox.objects': 'Objetos',
  'toolbox.relations': 'Relaciones',
  'toolbox.ariaLabel': 'Paleta de elementos UML',
  'toolbox.collapse': 'Contraer la caja de herramientas',
  'toolbox.expand': 'Expandir la caja de herramientas',
  'tool.class': 'Clase',
  'tool.interface': 'Interfaz',
  'tool.association': 'Asociación',
  'tool.associationClass': 'Clase de asociación',
  'tool.aggregation': 'Agregación',
  'tool.composition': 'Composición',
  'tool.generalization': 'Generalización',
  'tool.realization': 'Realización',
  'tool.dependency': 'Dependencia',
  'tool.nary': 'N-aria',
  'palette.createClassAria': 'Crear clase (arrastrar al lienzo)',
  'palette.createInterfaceAria': 'Crear interfaz (arrastrar al lienzo)',
  'palette.edgeToolAria': 'herramienta de borde {label}',
  'palette.naryAria': 'herramienta de asociación n-aria (seleccionar 3 o más clases)',
  'palette.dragClassTitle': 'Arrastre sobre el lienzo para crear una clase',
  'palette.dragInterfaceTitle': 'Arrastre sobre el lienzo para crear una interfaz',
  'palette.armToolTitle': 'Haga clic y arrastre entre dos clases para crear una {label}',
  'palette.naryTitle': 'Haga clic y luego seleccione al menos tres clases',

  'canvas.addClass': 'Agregar clase',
  'canvas.addInterface': 'Agregar interfaz',
  'canvas.linkClasses': 'Vincular clases',
  'canvas.cancelLink': 'Cancelar vínculo',
  'canvas.naryAssociation': 'Asociación n-aria',
  'canvas.cancelNary': 'Cancelar n-aria',
  'canvas.directed': 'Dirigida',
  'canvas.selectTarget': 'Seleccione la clase de destino',
  'canvas.edgeToolHint': 'Herramienta {tool} activa — arrastre desde una clase de origen hasta una clase de destino. Pulse Esc para cancelar.',
  'canvas.pageBoundary': 'Hoja del Diagrama',
  'canvas.zoomControls': 'Controles de zoom',
  'canvas.zoomIn': 'Acercar (último clic)',
  'canvas.zoomOut': 'Alejar (último clic)',
  'canvas.zoomReset': 'Ajustar vista',
  'canvas.zoomLevel': 'Nivel de zoom actual',

  'nary.panelTitle': 'Asociación n-aria — {n} de 3 o más clases seleccionadas',
  'nary.multiplicityFor': 'Multiplicidad de {name}',
  'nary.name': 'Nombre',
  'nary.nameAria': 'Nombre de la asociación n-aria',
  'nary.optional': 'opcional',
  'nary.create': 'Crear',
  'nary.createAria': 'Crear asociación n-aria',

  'editor.associationName': 'Nombre de la asociación',
  'editor.label': 'Etiqueta',
  'editor.labelAria': 'Etiqueta de {type}',
  'editor.sourceRole': 'Rol de origen',
  'editor.targetRole': 'Rol de destino',
  'editor.sourceMultiplicity': 'Multiplicidad de origen',
  'editor.targetMultiplicity': 'Multiplicidad de destino',
  'editor.diamondEnd': 'Extremo del rombo: {end}',
  'editor.endSource': 'Origen',
  'editor.endTarget': 'Destino',
  'editor.flipDiamondEnd': 'Invertir extremo del rombo',
  'editor.flipDiamondEndAria': 'Invertir el extremo del rombo hacia {end}',
  'editor.associationClass': 'Clase de asociación',
  'editor.noAssociationClass': '(Ninguna)',
  'editor.delete': 'Eliminar {type}',
  'editor.deleteAria': 'Eliminar {type} {id}',
  'editor.close': 'Cerrar',
  'editor.closeAria': 'Cerrar el editor de borde',

  'naryEditor.title': 'Asociación n-aria',
  'naryEditor.nameAria': 'Nombre n-ario',
  'naryEditor.endMultiplicityAria': 'Multiplicidad del extremo n-ario de {name}',
  'naryEditor.delete': 'Eliminar asociación n-aria',
  'naryEditor.deleteAria': 'Eliminar asociación n-aria {id}',
  'naryEditor.closeAria': 'Cerrar el editor n-ario',

  'panel.generalizationsFor': 'Generalizaciones de {name}',
  'panel.realizationsFor': 'Realizaciones de {name}',
  'panel.dependenciesFor': 'Dependencias de {name}',
  'panel.none': 'Ninguna',
  'panel.inheritsFrom': 'Hereda de {name}',
  'panel.inheritedBy': 'Heredado por {name}',
  'panel.realizes': 'Realiza {name}',
  'panel.realizedBy': 'Realizado por {name}',
  'panel.dependsOn': 'Depende de {name}',
  'panel.dependencyFrom': 'Dependencia de {name}',
  'panel.removeInheritance': 'Quitar herencia',
  'panel.removeInheritanceAria': 'Eliminar generalización {id}',
  'panel.removeRealization': 'Quitar realización',
  'panel.removeRealizationAria': 'Eliminar realización {id}',
  'panel.removeDependency': 'Quitar dependencia',
  'panel.removeDependencyAria': 'Eliminar dependencia {id}',

  'guard.bothEndsClasses': 'Ambos extremos de la conexión deben ser clases.',
  'guard.endpointsExist': 'Ambos extremos deben ser clases existentes.',
  'guard.invalidEndpoints': '{label} rechazada: extremos no válidos.',
  'guard.rejectedReason': '{label} rechazada: {reason}.',
  'guard.noSelfInheritance': 'Una clase no puede heredar de sí misma.',
  'guard.realizationTarget': 'Una realización debe apuntar a una interfaz («interface»).',
  'reason.cycle': 'esta herencia crearía un ciclo',
  'reason.duplicateGeneralization': 'este vínculo de herencia ya existe',
  'reason.realizationNotInterface': 'el destino debe ser una interfaz',
  'reason.duplicateRealization': 'esta realización ya existe',
  'reason.duplicateDependency': 'esta dependencia ya existe',
  'reason.classNotFound': 'una clase referenciada no existe',
  'reason.unknown': 'el modelo rechazó el cambio y quedó sin cambios',

  'node.deleteAria': 'Eliminar {name}',
  'node.noOtherClasses': 'No hay otras clases',
  'node.makeSubclassOf': 'Hacer subclase de {name}',
  'node.realize': 'Realizar {name}',
  'node.markAbstract': 'Marcar como abstracta',
  'node.unmarkAbstract': 'Quitar abstracta',
  'node.close': 'Cerrar',
  'node.closeMenuAria': 'Cerrar menú contextual',
  'node.attrNameRequired': 'El nombre del atributo es obligatorio',
  'node.methodNameRequired': 'El nombre del método es obligatorio',
  'node.nameTypeRequired': 'El nombre y el tipo son obligatorios',
  'node.phName': 'nombre',
  'node.phType': 'tipo',
  'node.phReturnType': 'tipo de retorno',
  'node.phParams': 'param: tipo, ...',
  'node.static': 'estático',
  'node.derived': 'derivado',
  'node.attrVisibilityAria': 'Visibilidad del atributo',
  'node.attrNameAria': 'Nombre del atributo',
  'node.attrTypeAria': 'Tipo del atributo',
  'node.attrMultiplicityAria': 'Multiplicidad del atributo',
  'node.attrStaticAria': 'Atributo estático',
  'node.attrDerivedAria': 'Atributo derivado',
  'node.addAttrAria': 'Agregar atributo',
  'node.methodVisibilityAria': 'Visibilidad del método',
  'node.methodNameAria': 'Nombre del método',
  'node.methodReturnTypeAria': 'Tipo de retorno del método',
  'node.methodParamsAria': 'Parámetros del método',
  'node.methodStaticAria': 'Método estático',
  'node.addMethodAria': 'Agregar método',
  'node.editAttrNameAria': 'Editar nombre del atributo',
  'node.editAttrTypeAria': 'Editar tipo del atributo',
  'node.editMethodNameAria': 'Editar nombre del método',
  'node.editMethodReturnTypeAria': 'Editar tipo de retorno del método',
  'node.editMethodParamsAria': 'Editar parámetros del método',
  'node.confirmEditAria': 'Confirmar edición',
  'node.cancelEditAria': 'Cancelar edición',
  'node.editAttrAria': 'Editar atributo {name}',
  'node.removeAttrAria': 'Quitar atributo {name}',
  'node.editMethodAria': 'Editar método {name}',
  'node.removeMethodAria': 'Quitar método {name}',
  'node.quickLinkerTitle': 'Arrastre hasta otro elemento para vincular, o hasta un lienzo vacío para crear y vincular',
};

const STRINGS: Record<Lang, Record<TKey, string>> = { en: EN, es: ES };

function readStoredLang(): Lang {
  if (typeof window === 'undefined' || window.localStorage === undefined) {
    return 'en';
  }
  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    return stored === 'es' ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

let current: Lang = readStoredLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

/** Cambia el idioma de la UI en vivo y persiste la elección. */
export function setLang(lang: Lang): void {
  current = lang;
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Modo privado / almacenamiento deshabilitado: la sesión igual cambia, solo que
    // no sobrevive a una recarga. Nunca romper la UI por problemas de persistencia.
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Traduce una cadena de UI, leyendo el idioma ACTUAL al momento de la llamada (utilizable
 * fuera de React). Los marcadores `{param}` se completan a partir de `params`.
 */
export function t(key: TKey, params?: Record<string, string | number>): string {
  let value: string = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  if (params !== undefined) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.split(`{${name}}`).join(String(replacement));
    }
  }
  return value;
}

/** Accesor reactivo: vuelve a renderizar el componente cuando cambia el idioma. */
export function useT(): { t: typeof t; lang: Lang; setLang: (lang: Lang) => void } {
  const lang = useSyncExternalStore(subscribe, getLang, getLang);
  return { t, lang, setLang };
}

/** Control segmentado EN/ES — el alternador de idioma visible (13e.11). */
export function LanguageToggle(): ReactElement {
  const { lang, setLang: choose } = useT();
  return (
    <span className="lang-toggle" role="group" aria-label="Language">
      <button
        type="button"
        data-testid="lang-en"
        className={`lang-toggle__option${lang === 'en' ? ' lang-toggle__option--active' : ''}`}
        aria-pressed={lang === 'en'}
        onClick={() => choose('en')}
      >
        EN
      </button>
      <button
        type="button"
        data-testid="lang-es"
        className={`lang-toggle__option${lang === 'es' ? ' lang-toggle__option--active' : ''}`}
        aria-pressed={lang === 'es'}
        onClick={() => choose('es')}
      >
        ES
      </button>
    </span>
  );
}
