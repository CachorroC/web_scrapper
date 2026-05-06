# Etnografía Digital de la Crisis Climática en el Antropoceno

Este repositorio constituye la base tecnológica de una investigación en ciencias sociales centrada en la intersección entre la comunicación periodística, la gobernanza algorítmica y la crisis climática contemporánea.

## Contexto Investigativo

En la era del **Antropoceno**, la producción y el consumo de información sobre la crisis climática no ocurren en un vacío comunicativo. Están mediados por infraestructuras digitales que operan bajo lógicas de atención y rentabilidad. Este proyecto busca desentrañar cómo:

1. **Algoritmos de Contenido:** Priorizan narrativas que generan mayor *engagement*, a menudo simplificando la complejidad del colapso ecológico.
2. **Burbujas de Filtro:** Segmentan a las audiencias en universos informativos cerrados, dificultando la construcción de consensos científicos y políticos.
3. **Cámaras de Eco:** Refuerzan sesgos preexistentes y facilitan la propagación de desinformación o negacionismo climático dentro de comunidades digitales específicas.

A través del *web scraping* y el análisis de datos masivos de interacciones en redes sociales, esta herramienta permite recolectar la "materia prima" para una etnografía digital que analice el pulso de la opinión pública y las estrategias editoriales de los medios de comunicación frente al calentamiento global.

## Capacidades del Sistema

El software ha sido diseñado como un motor de extracción robusto capaz de navegar la complejidad técnica de las plataformas de Meta (Facebook, Instagram) y Alphabet (YouTube).

- **YouTube Scraper:** Extracción profunda de comentarios y respuestas anidadas en videos y *Shorts*, capturando la jerarquía conversacional completa.
- **Instagram & Facebook Scrapers:** Recolección de interacciones en publicaciones de medios periodísticos para mapear la circulación de discursos.
- **Estructura de Datos:** Generación automática de archivos JSON (para preservar la jerarquía recursiva de los hilos de comentarios) y XLSX (para análisis estadísticos cuantitativos).
- **Sanitización Dinámica:** Normalización de metadatos y nombres de archivos para garantizar la integridad de los datos en diversos entornos operativos.

## Arquitectura de los Scrapers

Cada plataforma presenta desafíos técnicos únicos debido a sus infraestructuras de Renderizado del Lado del Cliente (CSR) y sus medidas de seguridad. Los módulos en `src/web/` operan bajo la siguiente lógica:

### YouTube (`src/web/youtube/`)

- **Bloqueo de Navegación SPA:** Inyecta un script inicial que secuestra las APIs de `history.pushState` y `replaceState` para evitar que el framework de YouTube navegue fuera del video durante la interacción con los comentarios.
- **Carga Infinita:** Implementa un bucle de *infinite scroll* que monitorea el cambio en la altura del DOM y el conteo de nodos para asegurar la carga completa de los hilos principales.
- **Expansión Recursiva:** Realiza un barrido sistemático para hidratar y hacer clic en todos los botones de "Ver respuestas" y "Mostrar más respuestas", reconstruyendo la jerarquía conversacional.

### Facebook (`src/web/facebook/`)

- **Gestión de Sesión:** Utiliza contextos persistentes y permite un intervalo de intervención manual para el inicio de sesión, crucial para acceder a secciones de comentarios protegidas.
- **Expansión Basada en Selectores:** Identifica dinámicamente botones de expansión mediante expresiones regulares (ej. `/Ver \d+ comentarios más/i`) para desplegar hilos anidados.
- **Extracción de Atributos:** Se apoya en etiquetas `aria-label` y roles de accesibilidad para identificar de forma robusta la autoría y el contenido en un DOM altamente ofuscado.

### Instagram (`src/web/instagram/`)

- **Detección por Iconografía:** Ante la ausencia de textos claros en los botones, el scraper utiliza selectores de SVG (ej. `aria-label="Load more comments"`) para gatillar la carga de datos adicionales.
- **Agrupamiento de Nodos:** Agrupa comentarios y sus respuestas correspondientes basándose en la estructura de listas (`<ul>`, `<li>`) propia de la interfaz móvil/web de Instagram.
- **Aplanamiento Hierárquico:** Incluye una utilidad de procesamiento para convertir estructuras recursivas en formatos planos compatibles con hojas de cálculo (XLSX) sin perder la trazabilidad del ID superior.

## Gestión y Análisis de Datos (`etnografia_digital/`)

La elección de los formatos de salida responde a la necesidad de integrar metodologías cualitativas y cuantitativas en la investigación social:

### Archivos JSON (Estructura Hierárquica)

- **Por qué:** Son fundamentales para la **etnografía digital**, ya que preservan la integridad de la conversación. Al mantener el anidamiento de respuestas, permiten analizar el flujo dialógico, las réplicas y la formación de micro-debates sin descontextualizar los comentarios.
- **Cómo:** El scraper construye un árbol de objetos en memoria donde cada nodo contiene metadatos del autor, texto, tiempo y una lista recursiva de respuestas. Este objeto se serializa directamente a disco para su uso en herramientas de análisis de redes o procesamiento de lenguaje natural (NLP).

### Archivos XLSX (Análisis Cuantitativo)

- **Por qué:** Facilitan el análisis estadístico descriptivo, la filtración por volumen de interacciones (likes) y la codificación manual de categorías. Es el formato preferido para investigadores que utilizan software de hojas de cálculo o herramientas de análisis cualitativo asistido por computadora (CAQDAS).
- **Cómo:** Se utiliza un algoritmo de "aplanamiento" que recorre el árbol JSON y genera una fila por cada comentario o respuesta. Para mantener la trazabilidad, se asignan identificadores únicos y referencias al `ParentID`, permitiendo reconstruir la relación de jerarquía en una tabla plana.

### Organización de Salida

Los datos se organizan siguiendo la ruta: `etnografia_digital/[plataforma]/[titulo_sanitizado]/`. Esta estructura automatizada garantiza que cada publicación analizada cuente con su propio ecosistema de archivos de datos, capturas de pantalla de error y metadatos, facilitando la gestión de grandes volúmenes de información recolectada durante la investigación.

## Estructura del Proyecto

El repositorio sigue una arquitectura modular en TypeScript:

- `src/web/`: Contiene los módulos de scraping específicos para cada plataforma (YouTube, Instagram, Facebook).
- `src/utils/`: Utilidades para la gestión de retardos, sanitización de archivos y manejo de sesiones de usuario.
- `src/types/`: Definiciones de tipos estrictos para garantizar la consistencia de los datos recolectados.
- `etnografia_digital/`: Directorio de salida donde se organizan los datos extraídos por plataforma y título de publicación.
- `logs/`: Registro detallado de las sesiones de extracción y copias de seguridad de la data.

## Configuración y Uso

### Requisitos Previos

- Node.js (v18+)
- Playwright (instalación de navegadores mediante `npx playwright install`)

### Instalación

```bash
npm install
```

### Ejecución

Para iniciar el proceso de recolección de datos:

```bash
npm run dev
```

## Finalidad de la Investigación

La finalidad última de este código no es solo la recolección de datos, sino la generación de evidencia empírica que permita cuestionar el rol de las plataformas digitales en la construcción del imaginario colectivo sobre el clima. Al analizar la arquitectura de la conversación digital, buscamos proponer estrategias comunicativas que rompan las cámaras de eco y fomenten una alfabetización climática crítica y transformadora.

---
*Este proyecto es parte de un esfuerzo académico por entender la complejidad de nuestra relación con el planeta en un mundo hiperconectado.*
