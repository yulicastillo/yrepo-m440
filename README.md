# YRepo Cloud v3.0

Convierte YRepo en un servicio accesible desde Internet para leer en Aidoku sin
mantener el PC encendido.

## Arquitectura

- Render ejecuta el proxy de imágenes.
- El mismo servicio publica `index.min.json`, el ícono y el archivo `.aix`.
- Aidoku usa una dirección HTTPS permanente.
- El PC solo se utiliza una vez para compilar y subir el proyecto.

## Seguridad

El proxy solo acepta imágenes de `stl.manhwa-online.com` y utiliza un token
incluido en la fuente. Se recomienda crear el repositorio de GitHub como privado.

## Orden de instalación

1. Crear un repositorio privado de GitHub y subir esta carpeta.
2. Crear en Render un Blueprint desde ese repositorio.
3. Copiar la URL pública que entregue Render.
4. Ejecutar `PREPARAR-FUENTE-CLOUD.bat` y pegar esa URL.
5. Ejecutar `SUBIR-A-GITHUB.bat`.
6. Esperar el nuevo despliegue de Render.
7. En Aidoku agregar:
   `https://TU-SERVICIO.onrender.com/index.min.json`

## Importante

Render Free se suspende después de un periodo sin tráfico. Al volver a abrir un
capítulo puede tardar aproximadamente un minuto en despertar. El código también
es compatible con otras plataformas Docker si Render no logra obtener las
imágenes desde su red.
