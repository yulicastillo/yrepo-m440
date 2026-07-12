@echo off
title Subir YRepo Cloud a GitHub
cd /d "%~dp0"
git add .
git commit -m "Actualizar YRepo Cloud"
git push
echo.
echo Si no aparecio ningun error, Render comenzara a desplegar automaticamente.
pause
