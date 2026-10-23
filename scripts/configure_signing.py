"""Добавляет конфигурацию подписи release APK в android/app/build.gradle.

Скрипт идемпотентен: повторный запуск не дублирует блок signingConfigs.
Параметры берутся из переменных окружения RELEASE_STORE_FILE и т.д.,
которые workflow кладёт в gradle.properties.
"""
import os
import re

path = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'build.gradle')
path = os.path.abspath(path)

with open(path, encoding='utf-8') as f:
    c = f.read()

changed = False

# 1. Блок signingConfigs перед buildTypes (если отсутствует)
if 'signingConfigs' not in c:
    block = '''    signingConfigs {
        release {
            storeFile file(RELEASE_STORE_FILE)
            storePassword RELEASE_STORE_PASSWORD
            keyAlias RELEASE_KEY_ALIAS
            keyPassword RELEASE_KEY_PASSWORD
        }
    }

'''
    idx = c.find('    buildTypes {')
    if idx == -1:
        raise SystemExit('buildTypes не найден в app/build.gradle — проверьте шаблон')
    c = c[:idx] + block + c[idx:]
    changed = True

# 2. Внутри buildTypes -> release добавляем signingConfig, если его нет
m = re.search(r'(buildTypes\s*\{.*?release\s*\{)(.*?)(\n(\s*)\})', c, re.S)
if m and 'signingConfig' not in m.group(2):
    inner = m.group(2).rstrip() + '\n        signingConfig signingConfigs.release\n'
    c = c[:m.end(1)] + inner + c[m.start(3):]
    changed = True

if changed:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(c)
    print('Подпись настроена в app/build.gradle')
else:
    print('Подпись уже настроена — без изменений')

print(c)
