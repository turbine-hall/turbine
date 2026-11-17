import { err } from '@turbine-hall/turbine-contracts';
import type { ModelAdapter } from './types.js';

export type OpenAICompatibleOptions = {
  id: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Optional organization header */
  organization?: string;
};

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw err('E_RUN_FAILURE', 'Model returned empty content (not valid JSON)');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* fall through */
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw err(
      'E_RUN_FAILURE',
      `Model did not return valid JSON. Raw response (truncated): ${trimmed.slice(0, 400)}`,
    );
  }
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: string }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

function systemForSchema(schemaId: string): string {
  if (schemaId === 'healthcheck') {
    return 'Return ONLY valid JSON: {"ok":true,"message":"pong"}';
  }
  return [
    'You are a Turbine Hall skill runner.',
    'Return ONLY valid JSON (no markdown fences).',
    `Respond with a JSON object matching schema "${schemaId}".`,
    'Distinguish confirmed facts from assumptions. Do not invent business decisions.',
    'Do not approve requirements, plans, merges, or deployments.',
    schemaId === 'assessment'
      ? 'Include fields: readiness, facts[{text,source}], assumptions[], unknowns[], proposedAcceptanceCriteria[{id,priority,statement,kind}], nonGoals[], riskHints[]. kind MUST be exactly one of: behavioral | technical | nonfunctional. priority is P0 | P1 | P2.'
      : '',
    schemaId === 'specification'
      ? 'Include fields: summary, requirements[{id (FR-001…),priority (P0|P1|P2),kind,statement (EARS: WHEN … THE SYSTEM SHALL …)}], nonGoals[], userFlow{steps[{from,to,message}]} (optional), testIntent[], requestCoverage[{itemId,requirementIds[],nonGoal?,question?}] covering EVERY item listed under REQUEST ITEMS. kind MUST be exactly one of: behavioral | technical | nonfunctional.'
      : '',
    schemaId === 'plan'
      ? 'Include fields: summary, steps[{id,description,requirementIds[],files[]}], testPlan[{requirementId,test,kind}], risks[{risk,mitigation}], estimatedComplexity. Every requirement ID must be covered by a step and every P0 by a test.'
      : '',
    schemaId === 'review'
      ? 'Include fields: findings[{severity,claim,file,line,quote}], claims{dependenciesAdded[],testFilesChanged[]}, coverage[{requirementId,testFile}], summary. Cite only files listed under CHANGED FILES; copy quotes exactly from the DIFF.'
      : '',
    schemaId === 'implement'
      ? 'Include fields: summary, filesTouched[], commandsToRun[], testCommands[], notes[]. For dependency updates, list exact package manager commands.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleOptions,
): ModelAdapter {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.TURBINE_MODEL_API_KEY;
  const baseUrl = (
    options.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    process.env.TURBINE_MODEL_BASE_URL ??
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');

  return {
    id: options.id,
    provider: 'openai-compatible',
    capabilities: {
      text: true,
      structuredOutput: true,
      toolCalling: false,
      maxContextTokens: 128000,
    },
    async run(request) {
      if (!apiKey) {
        throw err(
          'E_ADAPTER',
          'Missing API key. Set OPENAI_API_KEY (or TURBINE_MODEL_API_KEY) for real model mode.',
        );
      }

      const useJsonMode = process.env.TURBINE_MODEL_JSON_MODE !== '0';
      const body: Record<string, unknown> = {
        model: options.model,
        temperature: 0.2,
        // Newer OpenAI models prefer max_completion_tokens; many gateways still accept max_tokens.
        max_tokens: request.maxOutputTokens,
        messages: [
          { role: 'system', content: systemForSchema(request.schemaId) },
          {
            role: 'user',
            content:
              request.schemaId === 'healthcheck'
                ? 'Reply with {"ok":true,"message":"pong"}'
                : [
                    `workId=${request.workId}`,
                    `roleId=${request.roleId}`,
                    `skills=${request.skillIds.join(',')}`,
                    '',
                    request.prompt,
                  ].join('\n'),
          },
        ],
      };
      if (useJsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(options.organization
            ? { 'OpenAI-Organization': options.organization }
            : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        // Retry once without response_format / with max_completion_tokens for picky APIs
        if (res.status === 400 && useJsonMode) {
          const retryBody = {
            model: options.model,
            temperature: 0.2,
            max_completion_tokens: request.maxOutputTokens,
            messages: body.messages,
          };
          const retry = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(retryBody),
          });
          if (!retry.ok) {
            const retryText = await retry.text();
            throw err(
              'E_ADAPTER',
              `Model provider error ${retry.status}: ${retryText.slice(0, 500)}`,
            );
          }
          const retryData = (await retry.json()) as {
            id?: string;
            choices?: Array<{ message?: { content?: unknown } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const retryText = messageContentToText(retryData.choices?.[0]?.message?.content);
          return {
            content: extractJson(retryText),
            usage: {
              inputTokens: retryData.usage?.prompt_tokens,
              outputTokens: retryData.usage?.completion_tokens,
            },
            providerRequestId: retryData.id,
          };
        }
        throw err(
          'E_ADAPTER',
          `Model provider error ${res.status}: ${errBody.slice(0, 500)}`,
        );
      }

      const data = (await res.json()) as {
        id?: string;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      if (data.error?.message) {
        throw err('E_ADAPTER', `Model provider error: ${data.error.message}`);
      }
      const text = messageContentToText(data.choices?.[0]?.message?.content);
      const content = extractJson(text);
      return {
        content,
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
        },
        providerRequestId: data.id,
      };
    },
  };
}
