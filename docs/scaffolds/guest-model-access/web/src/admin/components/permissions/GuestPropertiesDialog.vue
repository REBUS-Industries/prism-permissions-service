<script setup lang="ts">
/**
 * Right-click / inspector dialog for Connector Light guest invite keys.
 */
import { computed, ref, watch } from 'vue';
import Icon from '../../../shared/Icon.vue';
import ProjectAccessTree from './ProjectAccessTree.vue';
import ModelAccessTree from './ModelAccessTree.vue';
import {
  LIGHT_CONNECTOR_FUNCTIONS,
  type ConnectorFunction,
  type InviteModelAccess,
  type OrbitProject,
} from '../../../shared/api';
import type { GuestInviteNodeMeta } from '../../utils/policyGraphLayout';

export interface GuestPropertiesModel {
  label: string;
  projectIds: string[];
  meta: GuestInviteNodeMeta;
}

const props = defineProps<{
  open: boolean;
  model: GuestPropertiesModel | null;
  projects: OrbitProject[];
  saving?: boolean;
  /** Plaintext key banner (shown after mint). */
  mintedKey?: string | null;
  mintedRedeemUrl?: string | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [GuestPropertiesModel];
  revoke: [];
  'copy-key': [text: string];
}>();

const label = ref('');
const projectIds = ref<string[]>([]);
const orbitTarget = ref<'prod' | 'dev'>('prod');
const allowedFunctions = ref<ConnectorFunction[]>([...LIGHT_CONNECTOR_FUNCTIONS]);
const maxRedemptions = ref('');
const expiresAt = ref('');
const modelAccess = ref<InviteModelAccess>('all');
const selectedModelIds = ref<string[]>([]);

const isNew = computed(() => !props.model?.meta.inviteKeyId);
const functionOptions = LIGHT_CONNECTOR_FUNCTIONS;
const canSave = computed(() => {
  if (!projectIds.value.length || !allowedFunctions.value.length) return false;
  if (modelAccess.value === 'selected' && !selectedModelIds.value.length) return false;
  return true;
});

watch(
  () => props.model,
  (m) => {
    if (!m) return;
    label.value = m.label;
    projectIds.value = [...m.projectIds];
    orbitTarget.value = m.meta.orbitTarget;
    allowedFunctions.value = [...m.meta.allowedFunctions];
    maxRedemptions.value = m.meta.maxRedemptions != null ? String(m.meta.maxRedemptions) : '';
    expiresAt.value = m.meta.expiresAt ? m.meta.expiresAt.slice(0, 16) : '';
    modelAccess.value = m.meta.modelAccess ?? 'all';
    selectedModelIds.value = [...(m.meta.selectedModelIds ?? [])];
  },
  { immediate: true },
);

function parseMaxRedemptions(): number | null {
  const raw = maxRedemptions.value.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseExpiresAt(): string | null {
  const raw = expiresAt.value.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function onSave() {
  if (!props.model) return;
  emit('save', {
    label: label.value.trim() || 'Guest',
    projectIds: [...projectIds.value],
    meta: {
      ...props.model.meta,
      orbitTarget: orbitTarget.value,
      allowedFunctions: [...allowedFunctions.value],
      maxRedemptions: parseMaxRedemptions(),
      expiresAt: parseExpiresAt(),
      modelAccess: modelAccess.value,
      selectedModelIds: modelAccess.value === 'selected' ? [...selectedModelIds.value] : [],
      dirty: true,
    },
  });
}

async function copy(text: string) {
  emit('copy-key', text);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div v-if="open && model" class="guest-dialog-backdrop" @click.self="emit('close')">
    <div class="guest-dialog" role="dialog" aria-modal="true" aria-labelledby="guest-dialog-title">
      <header class="guest-dialog__head">
        <div>
          <h2 id="guest-dialog-title">{{ isNew ? 'New guest' : 'Guest properties' }}</h2>
          <p class="muted">
            Connector Light invite key — wire this guest to project nodes on the graph, or pick projects below.
          </p>
        </div>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </header>

      <div v-if="mintedKey" class="guest-dialog__minted">
        <strong>Invite key — copy now; plaintext is shown only once.</strong>
        <div class="minted-row">
          <pre>{{ mintedKey }}</pre>
          <button type="button" class="small" @click="copy(mintedKey)">Copy key</button>
        </div>
        <div v-if="mintedRedeemUrl" class="minted-row">
          <pre>{{ mintedRedeemUrl }}</pre>
          <button type="button" class="small" @click="copy(mintedRedeemUrl)">Copy URL</button>
        </div>
      </div>

      <div class="guest-dialog__body">
        <div class="form-grid">
          <label>
            Guest name
            <input v-model="label" placeholder="Acme collaborator" autocomplete="off" />
          </label>
          <label>
            ORBIT target
            <select v-model="orbitTarget">
              <option value="prod">prod</option>
              <option value="dev">dev</option>
            </select>
          </label>
          <label>
            Max redemptions
            <input v-model="maxRedemptions" type="number" min="1" placeholder="Unlimited" />
          </label>
          <label>
            Expires
            <input v-model="expiresAt" type="datetime-local" />
          </label>
        </div>

        <div class="block">
          <span class="field-label">ORBIT project access</span>
          <ProjectAccessTree v-model="projectIds" :projects="projects" />
        </div>

        <div class="block">
          <span class="field-label">Model access</span>
          <div class="mode-grid">
            <label class="mode-radio">
              <input v-model="modelAccess" type="radio" value="all" />
              <span>
                <strong>All models</strong>
                <span class="muted small">Every model in the granted projects</span>
              </span>
            </label>
            <label class="mode-radio">
              <input v-model="modelAccess" type="radio" value="selected" />
              <span>
                <strong>Selected models</strong>
                <span class="muted small">Only models you pick below</span>
              </span>
            </label>
            <label class="mode-radio">
              <input v-model="modelAccess" type="radio" value="authored" />
              <span>
                <strong>Authored by this guest</strong>
                <span class="muted small">Models with Orbit property <code>userId</code> = invite identity</span>
              </span>
            </label>
          </div>
          <ModelAccessTree
            v-if="modelAccess === 'selected'"
            v-model="selectedModelIds"
            :projects="projects"
            :project-ids="projectIds"
            :orbit-target="orbitTarget"
          />
        </div>

        <div class="block">
          <span class="field-label">Allowed functions</span>
          <div class="fn-grid">
            <label v-for="fn in functionOptions" :key="fn" class="fn-check">
              <input v-model="allowedFunctions" type="checkbox" :value="fn" />
              {{ fn }}
            </label>
          </div>
          <p class="muted small">Light keys cannot grant <code>receive</code> or <code>create_project</code>.</p>
        </div>

        <p v-if="model.meta.inviteKeyId" class="muted small">
          Redemptions: {{ model.meta.redemptionCount ?? 0 }}
          <span v-if="model.meta.maxRedemptions != null">/ {{ model.meta.maxRedemptions }}</span>
          · id {{ model.meta.inviteKeyId.slice(0, 8) }}…
        </p>
      </div>

      <footer class="guest-dialog__foot">
        <button
          v-if="!isNew"
          type="button"
          class="danger-btn"
          :disabled="saving"
          @click="emit('revoke')"
        >
          Revoke key
        </button>
        <div class="spacer" />
        <button type="button" class="secondary" :disabled="saving" @click="emit('close')">Cancel</button>
        <button
          type="button"
          class="primary"
          :disabled="saving || !canSave"
          @click="onSave"
        >
          {{ saving ? 'Saving…' : isNew ? 'Create key' : 'Save' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.guest-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, #000 45%, transparent);
}
.guest-dialog {
  width: min(640px, 100%);
  max-height: min(90vh, 820px);
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated, var(--surface, #fff));
  border: 1px solid var(--color-border, var(--border));
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.guest-dialog__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--color-border, var(--border));
}
.guest-dialog__head h2 { margin: 0 0 4px; font-size: 16px; }
.guest-dialog__head .muted { margin: 0; font-size: 13px; }
.icon-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 4px;
  border-radius: 6px;
}
.icon-btn:hover { background: var(--color-bg-hover, rgba(0,0,0,.06)); }
.guest-dialog__minted {
  margin: 12px 18px 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--success, #16a34a) 35%, var(--color-border));
  background: color-mix(in srgb, var(--success, #16a34a) 8%, transparent);
  font-size: 13px;
}
.minted-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 8px;
}
.minted-row pre {
  flex: 1;
  margin: 0;
  font-size: 11px;
  word-break: break-all;
  white-space: pre-wrap;
}
.guest-dialog__body {
  padding: 14px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}
label :is(input, select) { font-weight: 400; }
.field-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.mode-grid { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.mode-radio {
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  font-weight: 400;
}
.mode-radio span { display: flex; flex-direction: column; gap: 2px; }
.mode-radio strong { font-size: 13px; }
.fn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
.fn-check { flex-direction: row; align-items: center; gap: 6px; font-weight: 400; }
.guest-dialog__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--color-border, var(--border));
}
.spacer { flex: 1; }
.danger-btn { color: var(--danger, #ef4444); }
.small { font-size: 12px; padding: 4px 8px; }
button.secondary, button.primary, button.danger-btn, button.small {
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
}
button.secondary { border: 1px solid var(--color-border, var(--border)); background: transparent; }
</style>
