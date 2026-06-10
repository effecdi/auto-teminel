#!/usr/bin/env python3
"""
Scenario.gg API 배치 이미지 생성 스크립트
무지개다리 게임 — 234개 에셋 자동 생성

사용법:
  python scenario_batch.py --api-key YOUR_KEY --api-secret YOUR_SECRET --model-id YOUR_MODEL_ID
  python scenario_batch.py --api-key YOUR_KEY --api-secret YOUR_SECRET --model-id YOUR_MODEL_ID --category dog_pose
  python scenario_batch.py --resume   # 중단된 작업 이어서 진행
  python scenario_batch.py --phase 1  # Phase 1 (42장) 만 생성

필요 패키지:
  pip install requests
"""

import argparse
import base64
import json
import os
import sys
import time
import requests
from pathlib import Path
from datetime import datetime

# ============================================================
# 공통 설정
# ============================================================

NEGATIVE_PROMPT = "realistic, 3D, photograph, sharp edges, dark, horror, ugly, deformed, blurry, low quality, watermark, text, extra limbs"

INFLUENCE = {
    "character": 0.75,
    "background": 0.55,
    "prop": 0.50,
    "effect": 0.50,
    "cg": 0.65,
    "ui": 0.45,
    "hazard": 0.45,
}

# Phase 1 필수 에셋 ID (42장 — 프로토타입용)
PHASE1_IDS = {
    "dog_idle_right", "dog_walk_1", "dog_walk_2", "dog_run_1", "dog_run_2",
    "dog_jump_up", "dog_sit", "dog_sleep_curled", "dog_ghost_appear", "dog_look_back",
    "dog_face_neutral", "dog_face_happy", "dog_face_sad", "dog_face_determined", "dog_face_worried",
    "owner_stand_front", "owner_sit_floor_cry", "owner_bed_lying", "owner_warmth_feel", "owner_hug_air",
    "owner_face_depressed", "owner_face_cry_heavy", "owner_face_cry_smile", "owner_face_surprised",
    "jade_stand_front", "jade_face_kind",
    "bg_room_sad", "bg_room_normal", "bg_bridge_start", "bg_heaven_realm",
    "bg_jade_throne", "bg_street_day", "bg_park_day",
    "fx_warmth_rays", "fx_shield_gold", "fx_pawprint_glow", "fx_ghost_appear",
    "cg_prologue_wake", "cg_prologue_jade", "cg_ch1_arrival",
    "prop_dog_collar", "prop_photo_together",
}

# ============================================================
# 프롬프트 정의 — 234개 에셋
# ============================================================

PROMPTS = {
    # ─────────────────────────────────────
    # A-1. 유령 강아지 포즈 (30장, 1024×1024)
    # ref: dog_ref.png | Influence: 0.75
    # ─────────────────────────────────────
    "dog_pose": [
        {"id": "dog_idle_right", "prompt": "pastel watercolor style, small fluffy white ghost dog standing on all fours, relaxed pose facing right, tail gently raised, soft lavender glow, sparkle effects on translucent fur, big round purple eyes, pink nose, pink cheeks, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_idle_left", "prompt": "pastel watercolor style, small fluffy white ghost dog standing on all fours, relaxed pose facing left, tail gently raised, soft lavender glow, sparkle effects, big round purple eyes, pink cheeks, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_walk_1", "prompt": "pastel watercolor style, small fluffy white ghost dog walking, right front paw forward, gentle stride, ears bouncing, tail up, soft lavender glow, sparkles trailing, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_walk_2", "prompt": "pastel watercolor style, small fluffy white ghost dog walking, left front paw forward, mid-stride, ears bouncing, tail up, lavender glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_walk_3", "prompt": "pastel watercolor style, small fluffy white ghost dog walking, both right paws forward, transition pose, light bounce, lavender glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_walk_4", "prompt": "pastel watercolor style, small fluffy white ghost dog walking, both left paws forward, transition pose, light bounce, lavender glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_run_1", "prompt": "pastel watercolor style, small fluffy white ghost dog running fast, front paws stretched forward, back paws pushed back, ears flapping, mouth open happy, tail streaming, lavender glow trail, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_run_2", "prompt": "pastel watercolor style, small fluffy white ghost dog running, all paws gathered under body, compressed gallop, ears pulled back, excited, lavender glow trail, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_run_3", "prompt": "pastel watercolor style, small fluffy white ghost dog running, front paws landing, back paws airborne, stretched gallop, joyful, sparkle particles, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_sit", "prompt": "pastel watercolor style, small fluffy white ghost dog sitting upright, front paws together, looking up with big purple eyes, tail on floor, lavender glow, sparkle effects, full body, front-side view, white background", "size": "1024x1024"},
        {"id": "dog_sit_side", "prompt": "pastel watercolor style, small fluffy white ghost dog sitting, side view, paws neatly placed, tail curled beside, calm expression, lavender glow, full body, white background", "size": "1024x1024"},
        {"id": "dog_sleep_curled", "prompt": "pastel watercolor style, small fluffy white ghost dog sleeping curled in a ball, eyes closed peacefully, nose tucked into tail, soft warm golden glow, gentle sparkles, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_sleep_belly", "prompt": "pastel watercolor style, small fluffy white ghost dog sleeping on side, belly exposed, legs stretched relaxed, peaceful, gentle snoring, golden glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_jump_up", "prompt": "pastel watercolor style, small fluffy white ghost dog jumping upward joyfully, all paws off ground, front paws reaching up, ears flying, mouth open happy, sparkle burst, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_jump_forward", "prompt": "pastel watercolor style, small fluffy white ghost dog leaping forward, front paws extended, mid-air, excited expression, lavender glow trail, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_nuzzle", "prompt": "pastel watercolor style, small fluffy white ghost dog pushing nose forward gently, eyes half closed lovingly, warm golden glow from nose, comforting pose, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_nuzzle_up", "prompt": "pastel watercolor style, small fluffy white ghost dog on hind legs slightly, nose pointing up, nuzzling upward, eyes closed, warm golden glow, loving expression, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_shake", "prompt": "pastel watercolor style, small fluffy white ghost dog shaking body vigorously, fur flying outward, motion blur on ears and tail, sparkle particles flying, funny happy face, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_tail_wag", "prompt": "pastel watercolor style, small fluffy white ghost dog standing still, tail wagging enthusiastically, motion blur on tail, happy excited, body wiggling, sparkles from tail, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_lying_relaxed", "prompt": "pastel watercolor style, small fluffy white ghost dog lying on belly, chin on front paws, back legs stretched, relaxed peaceful, lavender glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_lying_alert", "prompt": "pastel watercolor style, small fluffy white ghost dog lying on belly, head raised alert, ears perked, looking with interest, lavender glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_paw_raise", "prompt": "pastel watercolor style, small fluffy white ghost dog sitting, raising one front paw, cute begging gesture, head tilted, big purple eyes looking up, lavender glow, full body, front-side view, white background", "size": "1024x1024"},
        {"id": "dog_spin", "prompt": "pastel watercolor style, small fluffy white ghost dog spinning chasing tail, motion blur, excited joyful, sparkle circle trail, full body, slight top angle, white background", "size": "1024x1024"},
        {"id": "dog_sniff", "prompt": "pastel watercolor style, small fluffy white ghost dog nose to ground sniffing, tail raised, curious focused, small sparkle near nose, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_ghost_appear", "prompt": "pastel watercolor style, small fluffy white ghost dog materializing from thin air, semi-transparent fading in, sparkle particles swirling, lavender light burst, magical appearance, full body, front view, white background", "size": "1024x1024"},
        {"id": "dog_ghost_fade", "prompt": "pastel watercolor style, small fluffy white ghost dog fading away, becoming transparent, sparkles dissolving upward, sad gentle smile, lavender glow dimming, full body, front view, white background", "size": "1024x1024"},
        {"id": "dog_power_shield", "prompt": "pastel watercolor style, small fluffy white ghost dog standing firm, golden protective dome emanating from body, determined brave expression, eyes glowing, shield expanding, heroic pose, full body, front view, white background", "size": "1024x1024"},
        {"id": "dog_power_warmth", "prompt": "pastel watercolor style, small fluffy white ghost dog sitting, warm golden rays from chest, eyes closed, peaceful serene, golden particles floating outward, healing glow, full body, front view, white background", "size": "1024x1024"},
        {"id": "dog_power_pawprint", "prompt": "pastel watercolor style, small fluffy white ghost dog walking leaving glowing lavender paw prints, each step creates light burst, magical trail, full body, side view, white background", "size": "1024x1024"},
        {"id": "dog_look_back", "prompt": "pastel watercolor style, small fluffy white ghost dog standing, looking back over shoulder, gentle sad smile, one paw raised, farewell pose, lavender glow, full body, side view, white background", "size": "1024x1024"},
    ],

    # ─────────────────────────────────────
    # A-2. 강아지 표정 (15장, 768×768)
    # ─────────────────────────────────────
    "dog_face": [
        {"id": "dog_face_neutral", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, calm neutral expression, big round purple eyes, small pink nose, lavender glow, front view, white background", "size": "768x768"},
        {"id": "dog_face_happy", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, happy joyful smile, sparkling purple eyes wide open, mouth slightly open, pink cheeks blushing, warm glow, front view, white background", "size": "768x768"},
        {"id": "dog_face_very_happy", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, extremely happy, eyes closed in joy, big open mouth smile, pink cheeks, sparkle effects, bright glow, front view, white background", "size": "768x768"},
        {"id": "dog_face_sad", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, sad expression, teary purple eyes, droopy ears, mouth turned down, small tear, dimmed glow, front view, white background", "size": "768x768"},
        {"id": "dog_face_crying", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, crying, tears streaming from purple eyes, whimpering, ears drooped, very sad, front view, white background", "size": "768x768"},
        {"id": "dog_face_surprised", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, surprised shocked, wide open purple eyes, ears perked straight up, small open mouth, front view, white background", "size": "768x768"},
        {"id": "dog_face_worried", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, worried anxious, furrowed brows, alert ears, concerned eyes, front view, white background", "size": "768x768"},
        {"id": "dog_face_sleepy", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, sleepy drowsy, half closed eyes, small yawn, droopy ears, front view, white background", "size": "768x768"},
        {"id": "dog_face_angry", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, angry pouty, puffed cheeks, furrowed brows, determined eyes, front view, white background", "size": "768x768"},
        {"id": "dog_face_loving", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, loving adoring, soft half-closed eyes, sweet smile, warm golden glow, heart sparkle, front view, white background", "size": "768x768"},
        {"id": "dog_face_determined", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, determined brave, firm mouth, focused purple eyes, ears forward, confident, glow intensifying, front view, white background", "size": "768x768"},
        {"id": "dog_face_confused", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, confused puzzled, head tilted, one ear up one down, curious eyes, front view, white background", "size": "768x768"},
        {"id": "dog_face_peaceful", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, peaceful serene, eyes gently closed, slight smile, warm soft glow, front view, white background", "size": "768x768"},
        {"id": "dog_face_excited", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, extremely excited, tongue out, eyes sparkling, ears perked high, vibrating energy, sparkle effects, front view, white background", "size": "768x768"},
        {"id": "dog_face_lonely", "prompt": "pastel watercolor style, small fluffy white ghost dog face close up, lonely melancholic, distant unfocused eyes, slight frown, dimmed glow, quiet sadness, front view, white background", "size": "768x768"},
    ],

    # ─────────────────────────────────────
    # B-1. 보호자 하은 포즈 (28장, 1024×1024)
    # ref: owner_ref.png | Influence: 0.75
    # ─────────────────────────────────────
    "owner_pose": [
        {"id": "owner_stand_front", "prompt": "pastel watercolor style, young woman chibi 3 head ratio, standing straight, arms at sides, neutral expression, long dark brown wavy hair, big brown eyes, pink cheeks, cream t-shirt, pink sweatpants, white slippers, full body, front view, white background", "size": "1024x1024"},
        {"id": "owner_stand_side", "prompt": "pastel watercolor style, young woman chibi 3 head ratio, standing straight, arms at sides, long dark brown wavy hair, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_walk_right", "prompt": "pastel watercolor style, young woman chibi, walking slowly right, gentle steps, arms swaying, hair flowing, tired expression, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_walk_left", "prompt": "pastel watercolor style, young woman chibi, walking slowly left, gentle steps, arms swaying, hair flowing, tired expression, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_walk_happy", "prompt": "pastel watercolor style, young woman chibi, walking with spring in step, bouncy stride, gentle smile, hair flowing, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_sit_floor_cry", "prompt": "pastel watercolor style, young woman chibi, sitting on floor, knees hugged to chest, crying with tears, head buried in knees, dark hair covering face, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_sit_floor_hug", "prompt": "pastel watercolor style, young woman chibi, sitting on floor, hugging photo frame to chest, tears, looking down, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_bed_lying", "prompt": "pastel watercolor style, young woman chibi, lying in bed, eyes open staring at ceiling blankly, depressed, blanket to chin, dark hair on pillow, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_bed_curled", "prompt": "pastel watercolor style, young woman chibi, lying in bed curled up, facing wall, fetal position, blanket wrapped, only dark hair visible, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_couch_blank", "prompt": "pastel watercolor style, young woman chibi, sitting on couch, staring blankly, slouched, phone held loosely, empty expression, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_couch_tv", "prompt": "pastel watercolor style, young woman chibi, sitting on couch watching TV, blank expression, remote in hand, slouched, untouched snacks beside, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_desk_work", "prompt": "pastel watercolor style, young woman chibi, sitting at desk, using laptop, tired focused, hunched shoulders, coffee cup, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_desk_cry", "prompt": "pastel watercolor style, young woman chibi, sitting at desk crying, hand covering face, shoulders shaking, tissues nearby, work clothes, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_kitchen_cook", "prompt": "pastel watercolor style, young woman chibi, standing at kitchen counter cooking, holding chopsticks, pot on stove, slightly better expression, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_eat_table", "prompt": "pastel watercolor style, young woman chibi, sitting at table eating rice bowl with chopsticks, slightly happier, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_eat_alone", "prompt": "pastel watercolor style, young woman chibi, sitting at table eating alone, single bowl, looking down, empty chair across, lonely, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_clean_room", "prompt": "pastel watercolor style, young woman chibi, cleaning room, holding cloth wiping shelf, determined, hair in ponytail, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_phone_call", "prompt": "pastel watercolor style, young woman chibi, standing holding phone to ear, talking, uncertain expression, fidgeting, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_park_bench", "prompt": "pastel watercolor style, young woman chibi, sitting on park bench, hands on lap, looking up at sky, pensive, wind blowing hair, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_park_bench_smile", "prompt": "pastel watercolor style, young woman chibi, sitting on park bench, gentle smile looking at sky, peaceful, wind blowing hair, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_umbrella_rain", "prompt": "pastel watercolor style, young woman chibi, walking in rain without umbrella, getting wet, looking down, hair clinging, soaked cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_cafe_friend", "prompt": "pastel watercolor style, young woman chibi, sitting at cafe table talking, small smile, coffee cup, across from another person, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_warmth_feel", "prompt": "pastel watercolor style, young woman chibi, standing still, hand on chest, looking around confused but comforted, soft golden glow surrounding, slight smile forming, cream t-shirt, pink sweatpants, full body, front view, white background", "size": "1024x1024"},
        {"id": "owner_hug_air", "prompt": "pastel watercolor style, young woman chibi, arms wrapped around herself hugging invisible something, eyes closed, tearful smile, golden glow, cream t-shirt, pink sweatpants, full body, front view, white background", "size": "1024x1024"},
        {"id": "owner_kneel_collar", "prompt": "pastel watercolor style, young woman chibi, kneeling on floor, holding dog collar in both hands tenderly, tears but smiling, cream t-shirt, pink sweatpants, full body, front view, white background", "size": "1024x1024"},
        {"id": "owner_look_up_sky", "prompt": "pastel watercolor style, young woman chibi, standing outside, looking up at sky with warm smile, hand shading eyes, wind blowing hair, hopeful, cream t-shirt, pink sweatpants, full body, side view, white background", "size": "1024x1024"},
        {"id": "owner_wave_sky", "prompt": "pastel watercolor style, young woman chibi, standing outside, waving at sky, tearful happy smile, saying goodbye, wind blowing hair, golden hour, cream t-shirt, pink sweatpants, full body, front view, white background", "size": "1024x1024"},
        {"id": "owner_morning_stretch", "prompt": "pastel watercolor style, young woman chibi, just woke up, stretching arms above head, yawning, messy hair, sunlight streaming on her, refreshed, cream t-shirt, pink sweatpants, full body, front view, white background", "size": "1024x1024"},
    ],

    # ─────────────────────────────────────
    # B-2. 보호자 표정 (15장, 768×768)
    # ─────────────────────────────────────
    "owner_face": [
        {"id": "owner_face_neutral", "prompt": "pastel watercolor style, young woman face chibi, close up, neutral tired expression, big brown eyes with slight bags, long dark brown wavy hair, pink cheeks, front view, white background", "size": "768x768"},
        {"id": "owner_face_depressed", "prompt": "pastel watercolor style, young woman face chibi, close up, blank empty stare, lifeless eyes, dark circles, no expression, depressed, front view, white background", "size": "768x768"},
        {"id": "owner_face_cry_light", "prompt": "pastel watercolor style, young woman face chibi, close up, lightly crying, single tear on cheek, trying to hold it in, trembling lips, red-rimmed eyes, front view, white background", "size": "768x768"},
        {"id": "owner_face_cry_heavy", "prompt": "pastel watercolor style, young woman face chibi, close up, crying heavily, tears streaming both cheeks, red swollen eyes, runny nose, mouth open crying, front view, white background", "size": "768x768"},
        {"id": "owner_face_cry_smile", "prompt": "pastel watercolor style, young woman face chibi, close up, crying but smiling, tears falling with genuine smile, bittersweet expression, front view, white background", "size": "768x768"},
        {"id": "owner_face_smile_gentle", "prompt": "pastel watercolor style, young woman face chibi, close up, gentle soft smile, warm eyes, pink cheeks, comforted peaceful, front view, white background", "size": "768x768"},
        {"id": "owner_face_smile_bright", "prompt": "pastel watercolor style, young woman face chibi, close up, bright genuine happy smile, eyes closed in joy, warm pink cheeks, radiant, front view, white background", "size": "768x768"},
        {"id": "owner_face_surprised", "prompt": "pastel watercolor style, young woman face chibi, close up, surprised, wide open eyes, slightly open mouth, raised eyebrows, front view, white background", "size": "768x768"},
        {"id": "owner_face_confused", "prompt": "pastel watercolor style, young woman face chibi, close up, confused puzzled, head tilted, furrowed brows, uncertain eyes, front view, white background", "size": "768x768"},
        {"id": "owner_face_angry", "prompt": "pastel watercolor style, young woman face chibi, close up, angry annoyed, furrowed brows, tight lips, sharp eyes, front view, white background", "size": "768x768"},
        {"id": "owner_face_sleepy", "prompt": "pastel watercolor style, young woman face chibi, close up, very sleepy, heavy half-closed eyes, messy hair, yawning, bags under eyes, front view, white background", "size": "768x768"},
        {"id": "owner_face_nostalgic", "prompt": "pastel watercolor style, young woman face chibi, close up, nostalgic wistful, looking to side, distant eyes, slight smile, remembering, front view, white background", "size": "768x768"},
        {"id": "owner_face_hopeful", "prompt": "pastel watercolor style, young woman face chibi, close up, hopeful, eyes looking upward, sparkle in eyes, small determined smile, brighter complexion, front view, white background", "size": "768x768"},
        {"id": "owner_face_grateful", "prompt": "pastel watercolor style, young woman face chibi, close up, grateful deeply moved, glistening eyes, hand near heart, warm smile, front view, white background", "size": "768x768"},
        {"id": "owner_face_peaceful", "prompt": "pastel watercolor style, young woman face chibi, close up, peaceful at ease, eyes gently closed, serene calm smile, completely relaxed, front view, white background", "size": "768x768"},
    ],

    # ─────────────────────────────────────
    # C-1. 옥황상제 포즈 (7장, 1024×1024)
    # ref: jade_emperor.png | Influence: 0.70
    # ─────────────────────────────────────
    "jade_pose": [
        {"id": "jade_stand_front", "prompt": "pastel watercolor style, wise celestial old man chibi 4 head ratio, long flowing white beard, gentle kind face, ornate golden robes with cloud patterns, holding tall golden staff with glowing orb, soft golden divine light, standing regally, full body, front view, white background", "size": "1024x1024"},
        {"id": "jade_stand_side", "prompt": "pastel watercolor style, wise celestial old man chibi, long white beard, golden robes, golden staff, standing, looking to side, dignified, golden glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "jade_sit_throne", "prompt": "pastel watercolor style, wise celestial old man chibi, sitting on golden cloud throne, staff beside, hands on knees, wise calm, golden robes, soft clouds and golden light, full body, front view, white background", "size": "1024x1024"},
        {"id": "jade_gesture_grant", "prompt": "pastel watercolor style, wise celestial old man chibi, one hand extended palm open, golden light from palm, granting power, staff in other hand, kind serious, golden robes, full body, front view, white background", "size": "1024x1024"},
        {"id": "jade_laugh", "prompt": "pastel watercolor style, wise celestial old man chibi, laughing heartily, eyes closed, mouth wide, beard bouncing, hand on belly, other holding staff, golden robes, joyful, full body, front view, white background", "size": "1024x1024"},
        {"id": "jade_point_down", "prompt": "pastel watercolor style, wise celestial old man chibi, pointing downward with staff, looking down with concern, golden robes, full body, side view, white background", "size": "1024x1024"},
        {"id": "jade_pat_head", "prompt": "pastel watercolor style, wise celestial old man chibi, bending down, hand reaching to pat, gentle fatherly smile, warm golden glow, golden robes, full body, side view, white background", "size": "1024x1024"},
    ],

    # ─────────────────────────────────────
    # C-2. 옥황상제 표정 (5장, 768×768)
    # ─────────────────────────────────────
    "jade_face": [
        {"id": "jade_face_wise", "prompt": "pastel watercolor style, wise old man face chibi, calm knowing expression, gentle eyes, long white beard, golden headpiece, golden glow, front view, white background", "size": "768x768"},
        {"id": "jade_face_kind", "prompt": "pastel watercolor style, wise old man face chibi, warm kind smile, grandfatherly eyes, long white beard, golden glow, front view, white background", "size": "768x768"},
        {"id": "jade_face_serious", "prompt": "pastel watercolor style, wise old man face chibi, serious concerned, thoughtful eyes, long white beard, slight frown, front view, white background", "size": "768x768"},
        {"id": "jade_face_laugh", "prompt": "pastel watercolor style, wise old man face chibi, laughing heartily, eyes scrunched closed, mouth wide, beard bouncing, joyful, front view, white background", "size": "768x768"},
        {"id": "jade_face_proud", "prompt": "pastel watercolor style, wise old man face chibi, proud approving, nodding, warm gentle eyes, satisfied smile, long white beard, front view, white background", "size": "768x768"},
    ],

    # ─────────────────────────────────────
    # D. NPC 동물 친구들 (10장)
    # ref: dog_ref.png (스타일 통일) | Influence: 0.65
    # ─────────────────────────────────────
    "npc": [
        {"id": "npc_cat_sit", "prompt": "pastel watercolor style, small ghost cat, translucent white with blue tint, sitting elegantly, tail wrapped around paws, aloof cool expression, half-closed blue eyes, soft blue glow, sparkles, full body, side view, white background", "size": "1024x1024"},
        {"id": "npc_cat_walk", "prompt": "pastel watercolor style, small ghost cat, translucent white blue tint, walking gracefully, tail up, elegant stride, cool calm, blue glow, full body, side view, white background", "size": "1024x1024"},
        {"id": "npc_cat_face", "prompt": "pastel watercolor style, ghost cat face close up, half-closed blue eyes, cool aloof smirk, translucent white fur, blue glow, front view, white background", "size": "768x768"},
        {"id": "npc_cat_face_caring", "prompt": "pastel watercolor style, ghost cat face close up, slightly concerned trying to hide it, looking to side, translucent white, blue glow, front view, white background", "size": "768x768"},
        {"id": "npc_golden_stand", "prompt": "pastel watercolor style, large ghost golden retriever, translucent white with gold tint, standing on all fours, big gentle smile, tongue out, warm brown eyes, golden glow, large friendly, full body, side view, white background", "size": "1024x1024"},
        {"id": "npc_golden_sit", "prompt": "pastel watercolor style, large ghost golden retriever, translucent golden tint, sitting, tail wagging, happy panting, warm eyes, golden glow, full body, front view, white background", "size": "1024x1024"},
        {"id": "npc_golden_face", "prompt": "pastel watercolor style, ghost golden retriever face close up, big happy smile, tongue out, warm brown eyes, friendly encouraging, golden glow, front view, white background", "size": "768x768"},
        {"id": "npc_hamster_stand", "prompt": "pastel watercolor style, tiny ghost hamster, translucent white pink tint, standing on hind legs, tiny paws together, round body, big sparkling black eyes, tiny pink nose, pink glow, very small cute, full body, front view, white background", "size": "1024x1024"},
        {"id": "npc_hamster_run", "prompt": "pastel watercolor style, tiny ghost hamster, translucent pink tint, running quickly on all fours, tiny legs moving fast, puffed cheeks, excited, pink glow trail, full body, side view, white background", "size": "1024x1024"},
        {"id": "npc_hamster_face", "prompt": "pastel watercolor style, ghost hamster face close up, big round sparkling black eyes, tiny pink nose, puffed cheeks, excited enthusiastic, pink glow, front view, white background", "size": "768x768"},
    ],

    # ─────────────────────────────────────
    # E-1. 배경 — 인간계 실내 (9장, 1920×1080)
    # Influence: 0.55
    # ─────────────────────────────────────
    "bg_indoor": [
        {"id": "bg_room_sad", "prompt": "pastel watercolor style, small apartment bedroom, very dark messy, curtains closed, cold blue-gray light, clothes scattered, empty food containers, used tissues, wilting plant, dusty photo frames face down, unmade bed, oppressive atmosphere, side scrolling game background, desaturated cold tones, wide panoramic", "size": "1920x1080"},
        {"id": "bg_room_normal", "prompt": "pastel watercolor style, small apartment bedroom, slightly messy, curtains half open, overcast gray daylight, clothes on chair, desk with laptop, dog photo on shelf, wilting plant, bed roughly made, muted colors, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_room_happy", "prompt": "pastel watercolor style, small apartment bedroom, clean cozy, curtains open, warm golden sunlight, tidy space, fresh flowers in vase, healthy plants, dog photo with candle, clean bed pink blanket, warm cream pink tones, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_living_room", "prompt": "pastel watercolor style, small cozy living room, beige sofa with cushions, small TV, coffee table, warm lamp, cream beige tones, wooden floor, dog toy in corner, bookshelf with photos, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_living_room_dark", "prompt": "pastel watercolor style, small living room in darkness, TV casting blue glow, scattered cushions, empty snack bowls, cold blue light only, lonely isolated, side scrolling game background, cold blue tones, wide panoramic", "size": "1920x1080"},
        {"id": "bg_kitchen", "prompt": "pastel watercolor style, small apartment kitchen, white counter and stove, rice cooker, dishes in sink, small window, warm overhead light, cream white tiles, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_kitchen_messy", "prompt": "pastel watercolor style, small kitchen messy, unwashed dishes piled, empty noodle containers, dusty stove, dim lighting, neglected, side scrolling game background, muted tones, wide panoramic", "size": "1920x1080"},
        {"id": "bg_hallway", "prompt": "pastel watercolor style, small apartment entrance hallway, shoe rack, coat hooks, small mirror, dim warm light, door with lock, wooden floor, narrow, side scrolling game background", "size": "1920x1080"},
        {"id": "bg_office", "prompt": "pastel watercolor style, office workspace, desk computer monitor, documents coffee cup, fluorescent light, gray cubicle, neutral gray beige, impersonal, side scrolling game background, wide panoramic", "size": "1920x1080"},
    ],

    # ─────────────────────────────────────
    # E-2. 배경 — 인간계 외부 (10장, 1920×1080)
    # ─────────────────────────────────────
    "bg_outdoor": [
        {"id": "bg_street_day", "prompt": "pastel watercolor style, quiet residential street, houses and apartments, trees lining sidewalk, crosswalk, streetlights, blue sky white clouds, warm afternoon sunlight, peaceful, fallen leaves, side scrolling game background, warm tones, wide panoramic", "size": "1920x1080"},
        {"id": "bg_street_evening", "prompt": "pastel watercolor style, quiet residential street golden hour, orange sunset casting long shadows, streetlights turning on, warm golden sky, side scrolling game background, golden tones, wide panoramic", "size": "1920x1080"},
        {"id": "bg_street_night", "prompt": "pastel watercolor style, quiet residential street at night, dark blue sky, warm streetlights, colored shop signs, peaceful quiet, stars visible, side scrolling game background, cool blue with warm spots, wide panoramic", "size": "1920x1080"},
        {"id": "bg_rainy_street", "prompt": "pastel watercolor style, rainy residential street, puddles reflecting lights, soft rain drops, gray overcast, wet glistening sidewalk, blurred lights through rain, melancholic, side scrolling game background, blue-gray tones, wide panoramic", "size": "1920x1080"},
        {"id": "bg_park_day", "prompt": "pastel watercolor style, small park, wooden bench, cherry blossom trees, pink petals blowing, green grass, warm sunset golden light, peaceful, empty swing set, small pond, side scrolling game background, warm pink tones, wide panoramic", "size": "1920x1080"},
        {"id": "bg_park_evening", "prompt": "pastel watercolor style, small park at evening, warm orange sunset, cherry trees silhouetted, bench, long warm shadows, golden hour, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_park_rain", "prompt": "pastel watercolor style, small park in rain, wet bench, cherry petals scattered wet on ground, gray sky, puddles, rain on leaves, lonely, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_cafe", "prompt": "pastel watercolor style, small cozy cafe interior, wooden tables chairs, warm pendant lights, coffee cups, pastel walls, large window, plants in pots, warm welcoming, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_shelter", "prompt": "pastel watercolor style, animal shelter interior, clean kennels with dogs, bright lighting, tiled floor, volunteer desk, leashes on wall, warm caring atmosphere, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_convenience", "prompt": "pastel watercolor style, small convenience store interior, brightly lit, aisles with snacks drinks, counter register, fluorescent light, tiled floor, late night, side scrolling game background", "size": "1920x1080"},
    ],

    # ─────────────────────────────────────
    # E-3. 배경 — 천상계 (8장, 1920×1080)
    # ─────────────────────────────────────
    "bg_heaven": [
        {"id": "bg_bridge_start", "prompt": "pastel watercolor style, beginning of rainbow bridge, golden glowing path into distance, pastel clouds below, lavender pink purple sky, sparkles and stars floating, ethereal magical, bright golden light ahead, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_bridge_middle", "prompt": "pastel watercolor style, middle of rainbow bridge, golden shimmering, clouds parting, rainbow colors subtly glowing in bridge, sparkles floating, heaven visible in distance, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_bridge_end", "prompt": "pastel watercolor style, end of rainbow bridge at heavenly gate, golden ornate gate, white gold clouds, divine warm light beyond, flowers along bridge railing, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_heaven_realm", "prompt": "pastel watercolor style, heavenly realm, vast golden clouds, floating islands with grass and flowers, waterfalls of light, pastel pink purple gold sky, wildflowers, animal spirits playing in distance, dreamy paradise, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_heaven_plaza", "prompt": "pastel watercolor style, celestial plaza, smooth golden cloud floor, ornate golden pillars with cloud patterns, flower petals floating, warm divine golden light from above, animal spirits walking, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_jade_throne", "prompt": "pastel watercolor style, celestial throne room, grand golden cloud chamber, elevated golden throne, ornate pillars, floating flowers, warm divine light streaming, heavenly court, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_heaven_garden", "prompt": "pastel watercolor style, heavenly garden eternal spring, rainbow flowers, crystal clear stream, golden butterflies, pastel sky, magical glowing plants, animal spirits resting, side scrolling game background, wide panoramic", "size": "1920x1080"},
        {"id": "bg_descent_portal", "prompt": "pastel watercolor style, magical portal of light in sky, swirling golden lavender light forming tunnel downward, clouds parting, sparkles spiraling inward, looking down toward earth, side scrolling game background, wide panoramic", "size": "1920x1080"},
    ],

    # ─────────────────────────────────────
    # F. 이펙트 / VFX (18장, 512×512)
    # Influence: 0.50
    # ─────────────────────────────────────
    "effect": [
        {"id": "fx_shield_gold", "prompt": "pastel watercolor style, soft golden protective bubble dome, transparent glowing barrier, warm golden light, sparkle particles on surface, shield effect, transparent background", "size": "512x512"},
        {"id": "fx_shield_activate", "prompt": "pastel watercolor style, golden shield activating expanding outward, burst of golden light, sparkle particles flying, protective dome forming, transparent background", "size": "512x512"},
        {"id": "fx_warmth_rays", "prompt": "pastel watercolor style, warm golden light rays from above, soft comforting beam, floating sparkles and tiny hearts in light, healing glow, transparent background", "size": "512x512"},
        {"id": "fx_warmth_pulse", "prompt": "pastel watercolor style, circular warm golden pulse wave expanding outward, soft edges, sparkle particles riding wave, comfort warmth effect, transparent background", "size": "512x512"},
        {"id": "fx_warmth_particles", "prompt": "pastel watercolor style, floating golden warm particles, soft round bokeh lights, gentle upward float, warm amber gold, comfort healing, transparent background", "size": "512x512"},
        {"id": "fx_pawprint_glow", "prompt": "pastel watercolor style, single glowing lavender paw print on ground, soft purple light emanating, gentle sparkle, magical ghost footprint, transparent background", "size": "512x512"},
        {"id": "fx_pawprint_trail", "prompt": "pastel watercolor style, trail of glowing lavender paw prints in a line, each progressively fading, sparkle particles, magical ghost trail, transparent background", "size": "512x512"},
        {"id": "fx_pawprint_circle", "prompt": "pastel watercolor style, circular pattern of glowing lavender paw prints, protective circle, soft purple light, magical barrier, transparent background", "size": "512x512"},
        {"id": "fx_sparkle_burst", "prompt": "pastel watercolor style, burst of sparkle star particles golden and white, radiating outward, joyful celebration effect, transparent background", "size": "512x512"},
        {"id": "fx_heart_float", "prompt": "pastel watercolor style, soft pink gold hearts floating upward, gentle glowing, various sizes, love warmth effect, transparent background", "size": "512x512"},
        {"id": "fx_tear_drops", "prompt": "pastel watercolor style, small blue tear drops falling, soft round shapes, glistening light, sadness effect, transparent background", "size": "512x512"},
        {"id": "fx_memory_sparkle", "prompt": "pastel watercolor style, golden white sparkle dust swirling in circle, memory flashback effect, nostalgic warm glow, transparent background", "size": "512x512"},
        {"id": "fx_rain_drops", "prompt": "pastel watercolor style, soft rain drops falling, light gray blue, gentle diagonal fall, rainy weather effect, transparent background", "size": "512x512"},
        {"id": "fx_cherry_petals", "prompt": "pastel watercolor style, soft pink cherry blossom petals floating falling, gentle wind, pastel pink, peaceful spring, transparent background", "size": "512x512"},
        {"id": "fx_sunlight_beam", "prompt": "pastel watercolor style, warm golden sunlight beam from upper corner, dust particles in light, warm cozy effect, transparent background", "size": "512x512"},
        {"id": "fx_golden_aura", "prompt": "pastel watercolor style, soft golden aura surrounding empty center, gentle pulsing light, warm comfort aura, character overlay, transparent background", "size": "512x512"},
        {"id": "fx_ghost_appear", "prompt": "pastel watercolor style, swirling lavender white sparkle particles, materialization effect, light bursting outward, ghostly appearance, transparent background", "size": "512x512"},
        {"id": "fx_ghost_disappear", "prompt": "pastel watercolor style, lavender white sparkle particles dissolving upward, fading away effect, particles floating dimming, transparent background", "size": "512x512"},
    ],

    # ─────────────────────────────────────
    # G. 소품 (21장, 512×512)
    # Influence: 0.50
    # ─────────────────────────────────────
    "prop": [
        {"id": "prop_dog_collar", "prompt": "pastel watercolor style, cute dog collar, pink fabric white polka dots, small golden bell charm, buckle, well-loved, transparent background", "size": "512x512"},
        {"id": "prop_dog_bowl", "prompt": "pastel watercolor style, small ceramic dog food bowl, pastel blue, paw print pattern on side, empty clean, transparent background", "size": "512x512"},
        {"id": "prop_dog_toy_ball", "prompt": "pastel watercolor style, small round dog toy ball, pastel pink, slightly worn, teeth marks, transparent background", "size": "512x512"},
        {"id": "prop_dog_toy_rope", "prompt": "pastel watercolor style, braided rope dog toy, pink and cream, knotted ends, slightly frayed, transparent background", "size": "512x512"},
        {"id": "prop_dog_leash", "prompt": "pastel watercolor style, retractable dog leash, pink handle, cream lead, paw print design on handle, transparent background", "size": "512x512"},
        {"id": "prop_dog_bed", "prompt": "pastel watercolor style, small round dog bed, soft plush cream, pink trim, indent from use, cozy, transparent background", "size": "512x512"},
        {"id": "prop_photo_together", "prompt": "pastel watercolor style, framed photo, wooden frame, chibi girl smiling hugging small white fluffy dog, happy warm memory, transparent background", "size": "512x512"},
        {"id": "prop_photo_puppy", "prompt": "pastel watercolor style, framed photo, wooden frame, tiny white puppy with big purple eyes, first day home, transparent background", "size": "512x512"},
        {"id": "prop_photo_park", "prompt": "pastel watercolor style, framed photo, wooden frame, girl and white dog at park with cherry blossoms, happy memory, transparent background", "size": "512x512"},
        {"id": "prop_photo_album", "prompt": "pastel watercolor style, open photo album, cream pages, several photos of girl and white dog, ribbon bookmark, nostalgic, transparent background", "size": "512x512"},
        {"id": "prop_plant_dead", "prompt": "pastel watercolor style, small potted plant, wilting brown droopy leaves, dry cracked soil, neglected, white pot, transparent background", "size": "512x512"},
        {"id": "prop_plant_alive", "prompt": "pastel watercolor style, small potted plant, healthy green leaves, small pink flowers blooming, fresh watered soil, white pot, transparent background", "size": "512x512"},
        {"id": "prop_tea_cup", "prompt": "pastel watercolor style, warm cup of tea, steam rising, cream mug with paw print design, cozy warm, transparent background", "size": "512x512"},
        {"id": "prop_tissue_box", "prompt": "pastel watercolor style, tissue box with crumpled used tissues scattered, pastel box, transparent background", "size": "512x512"},
        {"id": "prop_phone", "prompt": "pastel watercolor style, smartphone, screen showing photo of small white dog, transparent background", "size": "512x512"},
        {"id": "prop_candle", "prompt": "pastel watercolor style, small memorial candle, flickering flame, warm golden light, cream candle, glass holder, transparent background", "size": "512x512"},
        {"id": "prop_umbrella", "prompt": "pastel watercolor style, closed folded umbrella, pink, water drops on surface, transparent background", "size": "512x512"},
        {"id": "prop_magic_necklace", "prompt": "pastel watercolor style, small glowing golden necklace with star pendant, magical divine light, sparkle effects, transparent background", "size": "512x512"},
        {"id": "prop_golden_staff", "prompt": "pastel watercolor style, tall golden magical staff, ornate design, glowing orb at top, cloud patterns engraved, transparent background", "size": "512x512"},
        {"id": "prop_heaven_flower", "prompt": "pastel watercolor style, magical heaven flower, soft glowing petals, pastel pink gold, ethereal sparkles, transparent background", "size": "512x512"},
        {"id": "prop_ramen_cup", "prompt": "pastel watercolor style, empty instant ramen cup, disposable chopsticks, lonely late night food, transparent background", "size": "512x512"},
    ],

    # ─────────────────────────────────────
    # H. 위험 요소 (6장, 512×512)
    # Influence: 0.45
    # ─────────────────────────────────────
    "hazard": [
        {"id": "hazard_sign", "prompt": "pastel watercolor style, wooden street sign falling from above, cracking support, motion blur downward, dust particles, side view, white background", "size": "512x512"},
        {"id": "hazard_flower_pot", "prompt": "pastel watercolor style, terracotta flower pot falling from above, soil spilling, crack forming, motion blur, white background", "size": "512x512"},
        {"id": "hazard_car", "prompt": "pastel watercolor style, small car speeding from left, motion blur, headlights glaring, fast dangerous, side view, white background", "size": "512x512"},
        {"id": "hazard_bicycle", "prompt": "pastel watercolor style, bicycle speeding past, rider not paying attention, motion blur, fast, side view, white background", "size": "512x512"},
        {"id": "hazard_puddle", "prompt": "pastel watercolor style, deep dark puddle on sidewalk, hidden depth, rainy street, slip hazard, top-down view, white background", "size": "512x512"},
        {"id": "hazard_stairs_wet", "prompt": "pastel watercolor style, wet slippery stairs, water on steps, dangerous surface, side view, white background", "size": "512x512"},
    ],

    # ─────────────────────────────────────
    # I. CG 일러스트 / 컷씬 (34장, 1920×1080)
    # Influence: 0.65
    # ─────────────────────────────────────
    "cutscene": [
        {"id": "cg_prologue_wake", "prompt": "pastel watercolor style, small white ghost dog opening eyes on golden bridge, lying on bridge surface, lavender light surrounding, pastel clouds below, endless sky, confused peaceful, wide cinematic", "size": "1920x1080"},
        {"id": "cg_prologue_heaven", "prompt": "pastel watercolor style, small white ghost dog on golden bridge looking at heaven realm, vast paradise, golden light, floating islands, rainbow flowers, animal spirits in distance, awe wonder, wide cinematic", "size": "1920x1080"},
        {"id": "cg_prologue_jade", "prompt": "pastel watercolor style, small white ghost dog looking up at wise old man in golden robes, jade emperor bending to meet dog, kind smile, golden throne room, divine light, wide cinematic", "size": "1920x1080"},
        {"id": "cg_prologue_look_down", "prompt": "pastel watercolor style, small white ghost dog at cloud edge looking down through clouds, seeing tiny girl crying in dark room far below, worried expression, reaching paw toward scene, wide cinematic", "size": "1920x1080"},
        {"id": "cg_prologue_power", "prompt": "pastel watercolor style, jade emperor hand glowing golden touching ghost dog forehead, golden light transferring, sparkle burst, dog eyes glowing, golden necklace materializing, wide cinematic", "size": "1920x1080"},
        {"id": "cg_prologue_descend", "prompt": "pastel watercolor style, small white ghost dog leaping into swirling golden lavender portal, descending from heaven through clouds toward earth, determined brave, sparkle trail, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch1_arrival", "prompt": "pastel watercolor style, small transparent ghost dog appearing in dark messy bedroom, faint lavender glow, girl in bed background, tissues mess, dog looking worried sad, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch1_warmth", "prompt": "pastel watercolor style, small ghost dog beside bed, golden warm light from body, girl feeling warmth, dog eyes closed concentrating, golden glow spreading in dark room, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch1_pawprint", "prompt": "pastel watercolor style, girl sitting on floor staring at glowing lavender paw prints, confused startled, tears on face, paw prints fading with sparkles, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch2_shield", "prompt": "pastel watercolor style, golden protective bubble around girl on street, wooden sign bouncing off shield, girl startled, ghost dog determined, dramatic protection, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch2_rain", "prompt": "pastel watercolor style, girl walking alone in rain without umbrella, soaked looking down, small ghost dog walking beside matching pace, rain wet street reflections, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch2_park", "prompt": "pastel watercolor style, girl sitting alone on park bench at sunset, staring at empty space beside, ghost dog sitting there invisible to her, cherry petals golden sunset, bittersweet, wide cinematic", "size": "1920x1080"},
        {"id": "cg_memory_first", "prompt": "pastel watercolor style, golden vignette edges, girl receiving tiny white puppy first time, holding puppy up, both smiling, bright sunny room, joyful, dreamy memory filter, wide cinematic", "size": "1920x1080"},
        {"id": "cg_memory_park", "prompt": "pastel watercolor style, golden vignette edges, girl walking with small white dog in park, cherry blossoms, both happy, dog pulling leash excited, dreamy memory, wide cinematic", "size": "1920x1080"},
        {"id": "cg_memory_sleep", "prompt": "pastel watercolor style, golden vignette edges, girl sleeping in bed with small white dog curled beside, peaceful night, moonlight through window, cozy, dreamy memory, wide cinematic", "size": "1920x1080"},
        {"id": "cg_memory_birthday", "prompt": "pastel watercolor style, golden vignette edges, girl putting tiny party hat on white dog, small cake with candle, balloons, both happy, fun, dreamy memory, wide cinematic", "size": "1920x1080"},
        {"id": "cg_memory_bath", "prompt": "pastel watercolor style, golden vignette edges, girl bathing small white dog in tub, bubbles everywhere, dog annoyed cute, girl laughing, silly fun, dreamy memory, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch3_album", "prompt": "pastel watercolor style, girl on floor with photo album open, tears on pages but smiling, ghost dog beside looking at same photos, warm golden light, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch4_shelter", "prompt": "pastel watercolor style, girl kneeling at animal shelter reaching through kennel, small dog sniffing her hand, ghost dog watching behind with proud happy expression, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch4_final_warmth", "prompt": "pastel watercolor style, girl in clean bright room hand on chest eyes closed, gentle smile, ghost dog pouring all golden light, brilliant warm glow filling room, emotional climax, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ch4_goodbye", "prompt": "pastel watercolor style, girl reaching toward empty air, tearful understanding smile, ghost dog becoming transparent looking back lovingly, golden sparkles between them, farewell, wide cinematic", "size": "1920x1080"},
        {"id": "cg_epilogue_return", "prompt": "pastel watercolor style, ghost dog arriving at heaven through golden portal, looking back at closing portal, peaceful smile, golden necklace glowing, wide cinematic", "size": "1920x1080"},
        {"id": "cg_epilogue_praise", "prompt": "pastel watercolor style, jade emperor kneeling patting ghost dog head, proud warm smile, golden light, animal spirits watching cheering, wide cinematic", "size": "1920x1080"},
        {"id": "cg_epilogue_friends", "prompt": "pastel watercolor style, ghost cat golden retriever hamster welcoming ghost dog, happy reunion, all glowing in their colors, heaven garden, playful warm, wide cinematic", "size": "1920x1080"},
        {"id": "cg_epilogue_look_down", "prompt": "pastel watercolor style, ghost dog on cloud edge looking at earth, girl living happily clean room going outside smiling, dog wagging tail proud tears, sunset sky, wide cinematic", "size": "1920x1080"},
        {"id": "cg_epilogue_haeun_sky", "prompt": "pastel watercolor style, girl standing outside sunny day, looking up at sky, warm smile, wind blowing hair, waving at sky, cherry blossoms, bright sky hint of rainbow, wide cinematic", "size": "1920x1080"},
        {"id": "cg_epilogue_crossing", "prompt": "pastel watercolor style, ghost dog walking forward on golden bridge, back view toward brilliant light, tail wagging, peaceful stride, animal spirits alongside, rainbow in golden sky, wide cinematic", "size": "1920x1080"},
        {"id": "cg_epilogue_final", "prompt": "pastel watercolor style, split composition, top ghost dog happy in heaven garden with friends, bottom girl smiling at sunset with new small dog, golden thread of light connecting them, emotional finale, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ending_reborn_dog", "prompt": "pastel watercolor style, girl kneeling at shelter, new puppy running toward her, puppy has purple sparkling eyes, wagging tail, girl eyes widen with recognition, tears of joy, golden light, reunion, wide cinematic", "size": "1920x1080"},
        {"id": "cg_ending_reborn_human", "prompt": "pastel watercolor style, young woman holding baby in warm nursery, baby opens eyes revealing purple sparkling eyes, woman looks with love and mysterious warmth, golden glow around baby, wide cinematic", "size": "1920x1080"},
        {"id": "cg_sad_forced_return", "prompt": "pastel watercolor style, ghost dog being pulled upward by divine light, reaching paw back toward earth, desperate sad, dark clouds below showing girl in darkness, wide cinematic", "size": "1920x1080"},
        {"id": "cg_sad_look_down", "prompt": "pastel watercolor style, ghost dog on cloud looking down, girl alone in dark room not moving, dog has tears helpless, cold blue tones below, wide cinematic", "size": "1920x1080"},
        {"id": "cg_dream_reunion", "prompt": "pastel watercolor style, dreamlike scene, girl and white dog in flower field, girl can see and touch dog, both happy, ethereal dreamy, golden light, floating petals, surreal dreamscape, wide cinematic", "size": "1920x1080"},
        {"id": "cg_dream_goodbye", "prompt": "pastel watercolor style, dreamlike scene, girl holding ghost dog, dog fading as morning light appears, girl whispering goodbye, tears peaceful smile, dream dissolving into golden light, wide cinematic", "size": "1920x1080"},
    ],

    # ─────────────────────────────────────
    # J. UI 에셋 (17장, 512×512)
    # Influence: 0.45
    # ─────────────────────────────────────
    "ui": [
        {"id": "ui_icon_warmth", "prompt": "pastel watercolor style, circular icon, golden sun warm rays, small heart in center, warmth ability, golden glow, white background", "size": "512x512"},
        {"id": "ui_icon_shield", "prompt": "pastel watercolor style, circular icon, golden shield with sparkle, protection ability, golden glow, white background", "size": "512x512"},
        {"id": "ui_icon_pawprint", "prompt": "pastel watercolor style, circular icon, lavender paw print with sparkle trail, paw ability, purple glow, white background", "size": "512x512"},
        {"id": "ui_icon_presence", "prompt": "pastel watercolor style, circular icon, soft golden aura circle, staying near ability, warm glow, white background", "size": "512x512"},
        {"id": "ui_icon_memory", "prompt": "pastel watercolor style, circular icon, golden sparkle star with photo symbol, memory ability, golden glow, white background", "size": "512x512"},
        {"id": "ui_heart_empty", "prompt": "pastel watercolor style, heart shaped gauge outline empty, gray muted, condition meter, clean design, white background", "size": "512x512"},
        {"id": "ui_heart_low", "prompt": "pastel watercolor style, heart shaped gauge 25 percent filled, blue-gray cold color, sad state, white background", "size": "512x512"},
        {"id": "ui_heart_mid", "prompt": "pastel watercolor style, heart shaped gauge 50 percent filled, warm yellow, neutral state, white background", "size": "512x512"},
        {"id": "ui_heart_high", "prompt": "pastel watercolor style, heart shaped gauge 75 percent filled, warm pink, recovering state, white background", "size": "512x512"},
        {"id": "ui_heart_full", "prompt": "pastel watercolor style, heart shaped gauge 100 percent filled, bright golden with sparkle, healed state, glowing, white background", "size": "512x512"},
        {"id": "ui_dialogue_box", "prompt": "pastel watercolor style, game dialogue text box, rounded rectangle, semi-transparent cream white, soft shadow, pastel border, white background", "size": "512x512"},
        {"id": "ui_choice_button", "prompt": "pastel watercolor style, game choice button, rounded rectangle, soft pastel pink, gentle shadow, white background", "size": "512x512"},
        {"id": "ui_title_logo", "prompt": "pastel watercolor style, game title logo Korean text, golden lavender colors, ghost dog silhouette integrated, sparkle effects, white background", "size": "512x512"},
        {"id": "ui_title_bg", "prompt": "pastel watercolor style, title screen, golden bridge into sunset sky, small white ghost dog silhouette on bridge, pastel clouds, cherry petals, warm golden pink, wide panoramic", "size": "1920x1080"},
        {"id": "ui_loading", "prompt": "pastel watercolor style, cute paw print loading indicator, lavender color, circular spinning frame, simple clean, white background", "size": "512x512"},
        {"id": "ui_save_icon", "prompt": "pastel watercolor style, cute floppy disk save icon with paw print, pastel colors, simple, white background", "size": "512x512"},
        {"id": "ui_menu_button", "prompt": "pastel watercolor style, three horizontal lines menu button, pastel pink, rounded corners, white background", "size": "512x512"},
    ],
}


# ============================================================
# API 클라이언트
# ============================================================

class ScenarioAPI:
    """Scenario.gg API wrapper"""

    BASE_URL = "https://api.cloud.scenario.com/v1"

    def __init__(self, api_key: str, api_secret: str):
        self.session = requests.Session()
        credentials = base64.b64encode(f"{api_key}:{api_secret}".encode()).decode()
        self.session.headers.update({
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

    def generate(self, model_id: str, prompt: str, width: int, height: int,
                 num_images: int = 1, guidance: float = 7.0, num_steps: int = 30,
                 negative_prompt: str = None) -> dict:
        """이미지 생성 요청"""
        url = f"{self.BASE_URL}/models/{model_id}/inferences"
        payload = {
            "parameters": {
                "type": "txt2img",
                "prompt": prompt,
                "negativePrompt": negative_prompt or NEGATIVE_PROMPT,
                "numSamples": num_images,
                "width": width,
                "height": height,
                "guidance": guidance,
                "numInferenceSteps": num_steps,
            }
        }
        resp = self.session.post(url, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()

    def get_inference(self, model_id: str, inference_id: str) -> dict:
        """생성 상태 조회"""
        url = f"{self.BASE_URL}/models/{model_id}/inferences/{inference_id}"
        resp = self.session.get(url, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def download_image(self, image_url: str) -> bytes:
        """이미지 다운로드"""
        resp = self.session.get(image_url, timeout=120)
        resp.raise_for_status()
        return resp.content


# ============================================================
# 배치 생성 엔진
# ============================================================

class BatchGenerator:
    """배치 이미지 생성 관리"""

    def __init__(self, api: ScenarioAPI, model_id: str, output_dir: str):
        self.api = api
        self.model_id = model_id
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.progress_file = self.output_dir / "_progress.json"
        self.progress = self._load_progress()

    def _load_progress(self) -> dict:
        if self.progress_file.exists():
            with open(self.progress_file, "r") as f:
                return json.load(f)
        return {"completed": [], "failed": [], "pending_inferences": {}}

    def _save_progress(self):
        with open(self.progress_file, "w") as f:
            json.dump(self.progress, f, indent=2, ensure_ascii=False)

    def _parse_size(self, size_str: str) -> tuple:
        w, h = size_str.split("x")
        return int(w), int(h)

    def generate_category(self, category: str, num_images: int = 2,
                          guidance: float = 7.0, delay: float = 2.0,
                          phase: int = 0):
        """한 카테고리의 모든 에셋 생성. phase>0이면 해당 Phase 에셋만."""
        if category not in PROMPTS:
            print(f"[ERROR] Unknown category: {category}")
            print(f"Available: {', '.join(PROMPTS.keys())}")
            return

        prompts = PROMPTS[category]
        if phase == 1:
            prompts = [p for p in prompts if p["id"] in PHASE1_IDS]

        cat_dir = self.output_dir / category
        cat_dir.mkdir(exist_ok=True)

        total = len(prompts)
        completed_count = 0

        print(f"\n{'='*60}")
        phase_str = f" (Phase {phase})" if phase else ""
        print(f"  Category: {category}{phase_str} — {total} assets, {num_images} variants each")
        print(f"{'='*60}\n")

        for i, item in enumerate(prompts, 1):
            asset_id = item["id"]

            if asset_id in self.progress["completed"]:
                completed_count += 1
                print(f"  [{i}/{total}] {asset_id} — SKIP (already done)")
                continue

            w, h = self._parse_size(item["size"])

            print(f"  [{i}/{total}] {asset_id} — generating...")
            print(f"           size: {w}x{h}")

            try:
                result = self.api.generate(
                    model_id=self.model_id,
                    prompt=item["prompt"],
                    width=w, height=h,
                    num_images=num_images,
                    guidance=guidance,
                )

                inference_id = result.get("inference", {}).get("id")
                if not inference_id:
                    inference_id = result.get("inferenceId") or result.get("id")

                if not inference_id:
                    print(f"           [WARN] No inference ID: {json.dumps(result)[:200]}")
                    self.progress["failed"].append({"id": asset_id, "error": "no inference ID"})
                    self._save_progress()
                    continue

                print(f"           inference: {inference_id}")
                images = self._wait_for_completion(inference_id, timeout=300)

                if images:
                    for idx, img_data in enumerate(images):
                        img_url = img_data.get("url") or img_data.get("imageUrl")
                        if not img_url:
                            continue
                        filename = f"{asset_id}_{idx+1}.png"
                        filepath = cat_dir / filename
                        img_bytes = self.api.download_image(img_url)
                        with open(filepath, "wb") as f:
                            f.write(img_bytes)
                        print(f"           ✓ saved: {filename} ({len(img_bytes)//1024}KB)")

                    self.progress["completed"].append(asset_id)
                    completed_count += 1
                else:
                    print(f"           [FAIL] No images returned")
                    self.progress["failed"].append({"id": asset_id, "error": "no images"})

            except requests.exceptions.HTTPError as e:
                error_msg = str(e)
                if e.response is not None:
                    try:
                        error_msg = e.response.json()
                    except:
                        error_msg = e.response.text[:200]
                print(f"           [ERROR] HTTP: {error_msg}")
                self.progress["failed"].append({"id": asset_id, "error": str(error_msg)})

                if e.response is not None and e.response.status_code == 429:
                    retry_after = int(e.response.headers.get("Retry-After", 30))
                    print(f"           Rate limited. Waiting {retry_after}s...")
                    time.sleep(retry_after)

            except Exception as e:
                print(f"           [ERROR] {type(e).__name__}: {e}")
                self.progress["failed"].append({"id": asset_id, "error": str(e)})

            self._save_progress()

            if i < total:
                time.sleep(delay)

        print(f"\n{'='*60}")
        print(f"  {category} 완료: {completed_count}/{total} 성공")
        print(f"{'='*60}\n")

    def _wait_for_completion(self, inference_id: str, timeout: int = 300) -> list:
        start = time.time()
        poll_interval = 3

        while time.time() - start < timeout:
            try:
                result = self.api.get_inference(self.model_id, inference_id)
                inference = result.get("inference", result)
                status = inference.get("status", "unknown")

                if status == "succeeded":
                    return inference.get("images", [])
                elif status in ("failed", "canceled"):
                    print(f"           Status: {status}")
                    return []
                else:
                    progress = inference.get("progress", "?")
                    print(f"           polling... status={status} progress={progress}")

            except Exception as e:
                print(f"           poll error: {e}")

            time.sleep(poll_interval)
            poll_interval = min(poll_interval + 1, 10)

        print(f"           [TIMEOUT] after {timeout}s")
        return []

    def generate_all(self, num_images: int = 2, guidance: float = 7.0,
                     delay: float = 2.0, phase: int = 0):
        """전체 카테고리 생성"""
        categories = list(PROMPTS.keys())
        if phase == 1:
            total_assets = sum(1 for v in PROMPTS.values() for p in v if p["id"] in PHASE1_IDS)
        else:
            total_assets = sum(len(v) for v in PROMPTS.values())

        print(f"\n{'#'*60}")
        print(f"  무지개다리 게임 에셋 배치 생성")
        phase_str = f" (Phase {phase})" if phase else ""
        print(f"  총 {total_assets}개 에셋{phase_str}, {num_images}개 변형/에셋")
        print(f"  출력: {self.output_dir}")
        print(f"{'#'*60}\n")

        for cat in categories:
            self.generate_category(cat, num_images=num_images,
                                   guidance=guidance, delay=delay, phase=phase)

        self._print_final_report()

    def _print_final_report(self):
        total = sum(len(v) for v in PROMPTS.values())
        done = len(self.progress["completed"])
        failed = len(self.progress["failed"])

        print(f"\n{'#'*60}")
        print(f"  최종 리포트")
        print(f"{'#'*60}")
        print(f"  총 에셋: {total}")
        print(f"  완료: {done}")
        print(f"  실패: {failed}")
        print(f"  남은: {total - done - failed}")

        if self.progress["failed"]:
            print(f"\n  실패 목록:")
            for f in self.progress["failed"]:
                print(f"    - {f['id']}: {f['error']}")

        print(f"\n  출력: {self.output_dir}")
        print(f"  진행 파일: {self.progress_file}")
        print(f"{'#'*60}\n")

    def retry_failed(self, num_images: int = 2, guidance: float = 7.0, delay: float = 2.0):
        if not self.progress["failed"]:
            print("재시도할 실패 항목 없음")
            return

        failed_ids = [f["id"] for f in self.progress["failed"]]
        print(f"\n실패 항목 {len(failed_ids)}개 재시도")
        self.progress["failed"] = []
        self._save_progress()

        for category, prompts in PROMPTS.items():
            cat_dir = self.output_dir / category
            cat_dir.mkdir(exist_ok=True)

            for item in prompts:
                if item["id"] not in failed_ids:
                    continue

                asset_id = item["id"]
                w, h = self._parse_size(item["size"])

                print(f"\n  [RETRY] {asset_id}")
                try:
                    result = self.api.generate(
                        model_id=self.model_id,
                        prompt=item["prompt"],
                        width=w, height=h,
                        num_images=num_images,
                        guidance=guidance,
                    )

                    inference_id = result.get("inference", {}).get("id") or result.get("inferenceId")
                    if not inference_id:
                        self.progress["failed"].append({"id": asset_id, "error": "no inference ID"})
                        continue

                    images = self._wait_for_completion(inference_id)
                    if images:
                        for idx, img_data in enumerate(images):
                            img_url = img_data.get("url") or img_data.get("imageUrl")
                            if not img_url:
                                continue
                            filename = f"{asset_id}_{idx+1}.png"
                            img_bytes = self.api.download_image(img_url)
                            with open(cat_dir / filename, "wb") as f:
                                f.write(img_bytes)
                            print(f"    ✓ {filename}")
                        self.progress["completed"].append(asset_id)
                    else:
                        self.progress["failed"].append({"id": asset_id, "error": "retry failed"})
                except Exception as e:
                    print(f"    [ERROR] {e}")
                    self.progress["failed"].append({"id": asset_id, "error": str(e)})

                self._save_progress()
                time.sleep(delay)

        self._print_final_report()


# ============================================================
# CLI
# ============================================================

def list_categories():
    total = 0
    print("\n카테고리 목록:")
    print(f"{'Category':<20} {'Count':>5}  Description")
    print("-" * 65)
    desc_map = {
        "dog_pose": "강아지 포즈 (사이드뷰 30장)",
        "dog_face": "강아지 표정 (정면 15장)",
        "owner_pose": "보호자 하은 포즈 (28장)",
        "owner_face": "보호자 표정 (15장)",
        "jade_pose": "옥황상제 포즈 (7장)",
        "jade_face": "옥황상제 표정 (5장)",
        "npc": "NPC 동물 (고양이/골든/햄스터 10장)",
        "bg_indoor": "배경 — 인간계 실내 (9장)",
        "bg_outdoor": "배경 — 인간계 외부 (10장)",
        "bg_heaven": "배경 — 천상계 (8장)",
        "effect": "이펙트/VFX (18장)",
        "prop": "소품 (21장)",
        "hazard": "위험 요소 (6장)",
        "cutscene": "CG 일러스트/컷씬 (34장)",
        "ui": "UI 에셋 (17장)",
    }
    for cat, prompts in PROMPTS.items():
        count = len(prompts)
        total += count
        desc = desc_map.get(cat, "")
        print(f"  {cat:<20} {count:>3}    {desc}")
    print("-" * 65)
    print(f"  {'TOTAL':<20} {total:>3}")

    # Phase 1 수량
    phase1_count = sum(1 for v in PROMPTS.values() for p in v if p["id"] in PHASE1_IDS)
    print(f"\n  Phase 1 (프로토타입): {phase1_count}장")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="무지개다리 게임 — Scenario.gg API 배치 이미지 생성"
    )
    parser.add_argument("--api-key", help="Scenario.gg API Key")
    parser.add_argument("--api-secret", help="Scenario.gg API Secret")
    parser.add_argument("--model-id", help="커스텀 모델 ID")
    parser.add_argument("--category", help="특정 카테고리만 (예: dog_pose, owner_face)")
    parser.add_argument("--phase", type=int, default=0, help="Phase 1만 생성 (42장)")
    parser.add_argument("--output", default="./game_assets", help="출력 디렉토리")
    parser.add_argument("--num-images", type=int, default=2, help="에셋당 변형 수")
    parser.add_argument("--guidance", type=float, default=7.0, help="Guidance scale")
    parser.add_argument("--delay", type=float, default=2.0, help="요청 간 딜레이(초)")
    parser.add_argument("--resume", action="store_true", help="이전 진행 이어서")
    parser.add_argument("--retry", action="store_true", help="실패분 재시도")
    parser.add_argument("--list", action="store_true", help="카테고리 목록")
    parser.add_argument("--dry-run", action="store_true", help="프롬프트만 확인")

    args = parser.parse_args()

    if args.list:
        list_categories()
        return

    if args.dry_run:
        list_categories()
        if args.category:
            cat = args.category
            if cat in PROMPTS:
                prompts = PROMPTS[cat]
                if args.phase == 1:
                    prompts = [p for p in prompts if p["id"] in PHASE1_IDS]
                print(f"\n--- {cat} prompts ---")
                for p in prompts:
                    print(f"\n  [{p['id']}] ({p['size']})")
                    print(f"  {p['prompt']}")
        return

    api_key = args.api_key or os.environ.get("SCENARIO_API_KEY")
    api_secret = args.api_secret or os.environ.get("SCENARIO_API_SECRET")
    model_id = args.model_id or os.environ.get("SCENARIO_MODEL_ID")

    if not api_key or not api_secret:
        print("[ERROR] API key + secret 필요")
        print("  --api-key KEY --api-secret SECRET")
        print("  또는 환경변수: SCENARIO_API_KEY, SCENARIO_API_SECRET")
        sys.exit(1)

    if not model_id:
        print("[ERROR] 모델 ID 필요")
        print("  --model-id MODEL_ID")
        print("  또는 환경변수: SCENARIO_MODEL_ID")
        sys.exit(1)

    api = ScenarioAPI(api_key, api_secret)
    generator = BatchGenerator(api, model_id, args.output)

    if args.retry:
        generator.retry_failed(num_images=args.num_images, guidance=args.guidance, delay=args.delay)
    elif args.category:
        generator.generate_category(args.category, num_images=args.num_images,
                                    guidance=args.guidance, delay=args.delay, phase=args.phase)
    else:
        generator.generate_all(num_images=args.num_images, guidance=args.guidance,
                               delay=args.delay, phase=args.phase)


if __name__ == "__main__":
    main()
