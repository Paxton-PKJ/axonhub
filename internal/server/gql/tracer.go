package gql

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/99designs/gqlgen/graphql"
	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/gqlerror"
	"go.uber.org/zap"

	"github.com/looplj/axonhub/internal/contexts"
	"github.com/looplj/axonhub/internal/log"
	"github.com/looplj/axonhub/internal/pkg/xerrors"
	"github.com/looplj/axonhub/internal/tracing"
)

// sensitiveMutationFields lists Mutation fields that accept channel credentials,
// API keys, or quota cookies. Requests executing any of these fields omit
// variable values from debug logs and emit only safe error summaries to
// AccessLog, regardless of client-chosen variable names, aliases, or fragments.
var sensitiveMutationFields = map[string]struct{}{
	"createChannel":                 {},
	"duplicateChannel":              {},
	"bulkCreateChannels":            {},
	"updateChannel":                 {},
	"updateChannelSettings":         {},
	"bulkImportChannels":            {},
	"testChannel":                   {},
	"testChannelAPIKey":             {},
	"disableChannelAPIKey":          {},
	"enableChannelAPIKey":           {},
	"enableSelectedChannelAPIKeys":  {},
	"disableSelectedChannelAPIKeys": {},
	"deleteDisabledChannelAPIKeys":  {},
}

func operationHasSensitiveMutation(opCtx *graphql.OperationContext) bool {
	if opCtx == nil || opCtx.Operation == nil {
		// Safe default: if the operation could not be parsed or resolved,
		// avoid logging variables or raw parser/coercion errors.
		return true
	}
	if opCtx.Operation.Operation != ast.Mutation {
		return false
	}
	return selectionSetHasSensitiveField(opCtx.Operation.SelectionSet, opCtx.Doc, map[string]bool{})
}

func selectionSetHasSensitiveField(set ast.SelectionSet, doc *ast.QueryDocument, visited map[string]bool) bool {
	for _, sel := range set {
		switch s := sel.(type) {
		case *ast.Field:
			if _, ok := sensitiveMutationFields[s.Name]; ok {
				return true
			}
		case *ast.InlineFragment:
			if selectionSetHasSensitiveField(s.SelectionSet, doc, visited) {
				return true
			}
		case *ast.FragmentSpread:
			if visited[s.Name] {
				continue
			}
			visited[s.Name] = true
			if doc == nil {
				return true
			}
			frag := doc.Fragments.ForName(s.Name)
			if frag == nil {
				return true
			}
			if selectionSetHasSensitiveField(frag.SelectionSet, doc, visited) {
				return true
			}
		}
	}
	return false
}

func extractSafeGraphQLErrorCode(ext map[string]any) string {
	if ext == nil {
		return ""
	}
	var code string
	switch v := ext["code"].(type) {
	case string:
		code = v
	case xerrors.ErrorCode:
		code = string(v)
	default:
		return ""
	}
	if len(code) == 0 || len(code) > 64 {
		return ""
	}
	for i := 0; i < len(code); i++ {
		c := code[i]
		if (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '_' {
			return ""
		}
	}
	return code
}

func sanitizeGraphQLErrorForAccessLog(gqlErr *gqlerror.Error) error {
	if gqlErr != nil {
		if code := extractSafeGraphQLErrorCode(gqlErr.Extensions); code != "" {
			return fmt.Errorf("graphql error (code=%s)", code)
		}
	}
	return errors.New("graphql request failed (details redacted)")
}

// sensitiveVariableKeys are variable paths whose values must never reach the
// debug log for non-sensitive operations. Matching is case-insensitive on the
// final key segment; nested maps and slices are walked.
var sensitiveVariableKeys = map[string]struct{}{
	"authcookie":         {},
	"apikey":             {},
	"apikeynames":        {},
	"apikeystatechanges": {},
	"credentials":        {},
	"accesstoken":        {},
	"refreshtoken":       {},
	"password":           {},
	"secret":             {},
	"keys":               {},
	"enablekeys":         {},
	"disablekeys":        {},
}

func redactSensitiveVariables(v any) any {
	switch val := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, item := range val {
			if _, ok := sensitiveVariableKeys[strings.ToLower(k)]; ok {
				out[k] = "<redacted>"
			} else {
				out[k] = redactSensitiveVariables(item)
			}
		}
		return out
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = redactSensitiveVariables(item)
		}
		return out
	default:
		return v
	}
}

type loggingTracer struct{}

var _ interface {
	graphql.HandlerExtension
	graphql.ResponseInterceptor
} = &loggingTracer{}

func (t *loggingTracer) ExtensionName() string {
	return "logging_tracer"
}

func (t *loggingTracer) Validate(schema graphql.ExecutableSchema) error {
	return nil
}

func (t *loggingTracer) InterceptResponse(ctx context.Context, next graphql.ResponseHandler) *graphql.Response {
	sensitive := true
	if graphql.HasOperationContext(ctx) {
		opCtx := graphql.GetOperationContext(ctx)
		ctx = tracing.WithOperationName(ctx, opCtx.OperationName)
		sensitive = operationHasSensitiveMutation(opCtx)

		if log.DebugEnabled(ctx) {
			// The raw query text is intentionally not logged: GraphQL clients
			// may inline sensitive literals (e.g. a channel quota cookie)
			// instead of passing them as variables. For sensitive mutations,
			// variable values are omitted entirely regardless of client-chosen
			// variable names.
			if sensitive {
				log.Debug(ctx, "received graphql request",
					zap.String("operation", opCtx.OperationName),
				)
			} else {
				log.Debug(ctx, "received graphql request",
					zap.String("operation", opCtx.OperationName),
					zap.Any("variables", redactSensitiveVariables(opCtx.Variables)),
				)
			}
		}
	}

	resp := next(ctx)

	// Capture GraphQL errors to context for access logging.
	// Sensitive or unidentifiable requests record only a safe error summary
	// while returning the full business error to the client.
	if resp != nil && len(resp.Errors) > 0 {
		for _, gqlErr := range resp.Errors {
			if sensitive {
				contexts.AddError(ctx, sanitizeGraphQLErrorForAccessLog(gqlErr))
			} else {
				contexts.AddError(ctx, gqlErr)
			}
		}
	}

	return resp
}
