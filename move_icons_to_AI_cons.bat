@echo off
cd /d "%~dp0"
if not exist "public\AI_cons" mkdir "public\AI_cons"
if exist "public\chatgpt-icon.png" move "public\chatgpt-icon.png" "public\AI_cons\"
if exist "public\claude-ai-icon.png" move "public\claude-ai-icon.png" "public\AI_cons\"
if exist "public\deepseek-logo-icon.png" move "public\deepseek-logo-icon.png" "public\AI_cons\"
if exist "public\perplexity-ai-icon.png" move "public\perplexity-ai-icon.png" "public\AI_cons\"
if exist "public\manus-ai-icon.png" move "public\manus-ai-icon.png" "public\AI_cons\"
if exist "public\openclaw-icon.png" move "public\openclaw-icon.png" "public\AI_cons\"
if exist "public\yandexgpt-icon.png" move "public\yandexgpt-icon.png" "public\AI_cons\"
if exist "public\gigachat-icon.jpg" move "public\gigachat-icon.jpg" "public\AI_cons\"
echo Done. Icons moved to public\AI_cons\
