# 무지개다리 게임 — 에셋 우선순위

## 생성 방법: Scenario.gg
1. 커스텀 모델 또는 Anime/Illustration 모델 선택
2. 레퍼런스 이미지 첨부 (Image Reference)
3. Influence: 캐릭터 0.75, 배경 0.55, 소품 0.45
4. Negative: `realistic, 3D, photograph, sharp edges, dark, horror, ugly, deformed, blurry, low quality, watermark, text, extra limbs`

---

## Phase 1: 최소 플레이 가능 프로토타입 (42장)

> 이것만 있으면 프롤로그 ~ 챕터1 플레이 가능

### 1-1. 유령 강아지 필수 포즈 (10장, 1024×1024)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★1 | dog_idle_right | 기본 대기 |
| ★2 | dog_walk_1 | 걷기 프레임1 |
| ★3 | dog_walk_2 | 걷기 프레임2 |
| ★4 | dog_run_1 | 달리기 프레임1 |
| ★5 | dog_run_2 | 달리기 프레임2 |
| ★6 | dog_jump_up | 점프 |
| ★7 | dog_sit | 앉기 |
| ★8 | dog_sleep_curled | 잠자기 |
| ★9 | dog_ghost_appear | 등장 이펙트 |
| ★10 | dog_look_back | 뒤돌아보기 |

### 1-2. 강아지 표정 (5장, 768×768)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★11 | dog_face_neutral | 기본 |
| ★12 | dog_face_happy | 기쁨 |
| ★13 | dog_face_sad | 슬픔 |
| ★14 | dog_face_determined | 결의 |
| ★15 | dog_face_worried | 걱정 |

### 1-3. 보호자 하은 필수 포즈 (5장, 1024×1024)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★16 | owner_stand_front | 기본 서기 |
| ★17 | owner_sit_floor_cry | 바닥에 앉아 울기 |
| ★18 | owner_bed_lying | 침대 누워있기 |
| ★19 | owner_warmth_feel | 온기 느끼기 |
| ★20 | owner_hug_air | 허공 안기 |

### 1-4. 보호자 표정 (4장, 768×768)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★21 | owner_face_depressed | 우울 |
| ★22 | owner_face_cry_heavy | 울음 |
| ★23 | owner_face_cry_smile | 울면서 웃기 |
| ★24 | owner_face_surprised | 놀람 |

### 1-5. 옥황상제 (2장, 1024×1024)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★25 | jade_stand_front | 기본 서기 |
| ★26 | jade_face_kind | 자상한 표정 |

### 1-6. 배경 필수 (7장, 1920×1080)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★27 | bg_room_sad | 어두운 방 (챕터1) |
| ★28 | bg_room_normal | 보통 방 |
| ★29 | bg_bridge_start | 무지개다리 입구 (프롤로그) |
| ★30 | bg_heaven_realm | 천상계 |
| ★31 | bg_jade_throne | 옥황상제 방 |
| ★32 | bg_street_day | 거리 낮 |
| ★33 | bg_park_day | 공원 |

### 1-7. 이펙트 (4장, 512×512)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★34 | fx_warmth_rays | 온기 능력 |
| ★35 | fx_shield_gold | 보호막 능력 |
| ★36 | fx_pawprint_glow | 발자국 |
| ★37 | fx_ghost_appear | 등장 이펙트 |

### 1-8. CG 컷씬 (3장, 1920×1080)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★38 | cg_prologue_wake | 프롤로그: 다리 위 눈뜨기 |
| ★39 | cg_prologue_jade | 옥황상제 만남 |
| ★40 | cg_ch1_arrival | 방에 도착 |

### 1-9. 소품 (2장, 512×512)
| 순서 | 파일명 | 용도 |
|------|--------|------|
| ★41 | prop_dog_collar | 강아지 목줄 |
| ★42 | prop_photo_together | 함께 찍은 사진 |

---

## Phase 2: 챕터 2~3 + NPC 추가 (40장)

### 강아지 추가 포즈 (8장)
dog_idle_left, dog_walk_3, dog_walk_4, dog_run_3,
dog_nuzzle, dog_tail_wag, dog_shake, dog_sniff

### 강아지 표정 추가 (5장)
dog_face_very_happy, dog_face_crying, dog_face_sleepy,
dog_face_loving, dog_face_excited

### 보호자 추가 (8장)
owner_walk_right, owner_couch_blank, owner_kitchen_cook,
owner_eat_alone, owner_park_bench, owner_kneel_collar,
owner_face_smile_gentle, owner_face_nostalgic

### NPC 동물 (6장)
npc_cat_sit, npc_cat_face, npc_golden_stand,
npc_golden_face, npc_hamster_stand, npc_hamster_face

### 배경 추가 (6장)
bg_living_room, bg_kitchen, bg_street_evening,
bg_rainy_street, bg_bridge_middle, bg_heaven_garden

### CG 추가 (5장)
cg_ch2_shield, cg_ch2_rain, cg_memory_first,
cg_memory_park, cg_memory_sleep

### 소품/이펙트 추가 (4장)
fx_heart_float, fx_cherry_petals, prop_tea_cup, prop_tissue_box

---

## Phase 3: 챕터 4 + 엔딩 (40장)
(나머지 CG, 배경, 이펙트, 위험요소)

## Phase 4: 풀 에셋 (나머지 112장)
(모든 표정, 추가 포즈, UI, 나머지 소품)

---

## Scenario.gg 생성 순서 (Phase 1 기준)

### Day 1: 강아지 (15장)
1. dog_ref.png를 Image Reference로 첨부
2. Influence 0.75
3. 포즈 10장 → 표정 5장 순서로 생성

### Day 2: 보호자 + 옥황상제 (11장)
1. owner_ref.png 첨부, Influence 0.75
2. 포즈 5장 → 표정 4장
3. jade_emperor.png 첨부, 2장

### Day 3: 배경 + 이펙트 + 소품 + CG (16장)
1. 배경 7장 (Influence 0.55)
2. 이펙트 4장 (Influence 0.50)
3. 소품 2장 (Influence 0.50)
4. CG 3장 (Influence 0.65)
