#!/bin/bash
set -e

# 색상 정의
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 버전 타입 (기본값: patch)
VERSION_TYPE=${1:-patch}

# 유효한 버전 타입인지 확인
if [[ "$VERSION_TYPE" != "patch" && "$VERSION_TYPE" != "minor" && "$VERSION_TYPE" != "major" ]]; then
  echo -e "${RED}[ERROR] 잘못된 버전 타입: $VERSION_TYPE${NC}"
  echo -e "사용법: bash deploy.sh [patch|minor|major]"
  exit 1
fi

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Auto Deploy (로컬 빌드)${NC}"
echo -e "${CYAN}========================================${NC}"

# 현재 버전 확인
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${YELLOW}현재 버전: v${CURRENT_VERSION}${NC}"

# 버전 업
echo -e "${CYAN}[1/3] 버전 업 (${VERSION_TYPE})...${NC}"
NEW_VERSION=$(npm version "$VERSION_TYPE" --no-git-tag-version | tr -d 'v')
echo -e "${GREEN}  → v${NEW_VERSION}${NC}"

# 빌드
echo -e "${CYAN}[2/3] electron-builder --mac 빌드 중...${NC}"
npm run build:mac

# 결과 확인
echo -e "${CYAN}[3/3] 빌드 결과 확인${NC}"
echo -e "${CYAN}----------------------------------------${NC}"

DMG_FILE=$(find dist -name "*.dmg" -newer package.json 2>/dev/null | head -1)
if [ -n "$DMG_FILE" ]; then
  DMG_SIZE=$(du -h "$DMG_FILE" | cut -f1)
  echo -e "${GREEN}  DMG: ${DMG_FILE} (${DMG_SIZE})${NC}"
else
  echo -e "${YELLOW}  DMG 파일을 찾을 수 없습니다${NC}"
fi

APP_DIR=$(find dist/mac* -name "*.app" -maxdepth 1 2>/dev/null | head -1)
if [ -n "$APP_DIR" ]; then
  echo -e "${GREEN}  APP: ${APP_DIR}${NC}"
fi

echo -e "${CYAN}----------------------------------------${NC}"
echo -e "${GREEN}[완료] v${CURRENT_VERSION} → v${NEW_VERSION} 배포 빌드 성공!${NC}"
