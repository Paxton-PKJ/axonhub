// 职责: 提供单次 GraphQL 请求级别的渠道与密钥指纹索引缓存，并解析请求执行记录的实时密钥标签。
// 关联文件:
//   internal/server/gql/graphql.go
//   internal/server/gql/axonhub.resolvers.go
//   internal/objects/channel.go
// 遵循的 Rules:
//   .agents/rules/go-general.md
//   .agents/rules/ent-graphql.md
// 注意事项:
//   缓存仅绑定单次 GraphQL Operation 生命周期，请求结束后随 context 释放，不会跨请求持有旧名称。
//   并发字段解析同一 channelID 时合并加载请求，并将无权限或不存在的渠道记为负缓存。

package gql

import (
	"context"
	"strings"
	"sync"

	"github.com/99designs/gqlgen/graphql"
	"github.com/samber/lo"

	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/channel"
	"github.com/looplj/axonhub/internal/objects"
)

type requestCacheContextKey struct{}

type cachedChannelEntry struct {
	ch *ent.Channel
}

type inflightChannelLoad struct {
	done chan struct{}
	ch   *ent.Channel
	err  error
}

type channelFingerprintCacheKey struct {
	channelID         int
	updatedAtUnixNano int64
}

type fingerprintLabelEntry struct {
	name  string
	index int
}

type channelFingerprintIndex struct {
	refCount int
	byFP     map[string]fingerprintLabelEntry
}

type cachedFingerprintIndex struct {
	once sync.Once
	idx  channelFingerprintIndex
}

type gqlRequestCache struct {
	mu           sync.Mutex
	channels     map[int]cachedChannelEntry
	inflight     map[int]*inflightChannelLoad
	fingerprints map[channelFingerprintCacheKey]*cachedFingerprintIndex
}

func newGQLRequestCache() *gqlRequestCache {
	return &gqlRequestCache{
		channels:     make(map[int]cachedChannelEntry),
		inflight:     make(map[int]*inflightChannelLoad),
		fingerprints: make(map[channelFingerprintCacheKey]*cachedFingerprintIndex),
	}
}

func withRequestCache(ctx context.Context, next graphql.OperationHandler) graphql.ResponseHandler {
	if requestCacheFromContext(ctx) != nil {
		return next(ctx)
	}
	return next(context.WithValue(ctx, requestCacheContextKey{}, newGQLRequestCache()))
}

func requestCacheFromContext(ctx context.Context) *gqlRequestCache {
	if ctx == nil {
		return nil
	}
	cache, _ := ctx.Value(requestCacheContextKey{}).(*gqlRequestCache)
	return cache
}

func cloneCachedChannel(ch *ent.Channel) *ent.Channel {
	if ch == nil {
		return nil
	}
	clone := *ch
	return &clone
}

func (c *gqlRequestCache) getOrLoadChannel(
	channelID int,
	load func() (*ent.Channel, error),
) (*ent.Channel, error) {
	c.mu.Lock()
	if cached, ok := c.channels[channelID]; ok {
		c.mu.Unlock()
		return cloneCachedChannel(cached.ch), nil
	}
	if inflight, ok := c.inflight[channelID]; ok {
		c.mu.Unlock()
		<-inflight.done
		return cloneCachedChannel(inflight.ch), inflight.err
	}
	inflight := &inflightChannelLoad{done: make(chan struct{})}
	c.inflight[channelID] = inflight
	c.mu.Unlock()

	ch, err := load()

	c.mu.Lock()
	delete(c.inflight, channelID)
	inflight.ch = ch
	inflight.err = err
	if err == nil {
		// Cache both hits and nil negative results (not found / privacy deny) for this request.
		c.channels[channelID] = cachedChannelEntry{ch: ch}
	}
	close(inflight.done)
	c.mu.Unlock()

	return cloneCachedChannel(ch), err
}

func (c *gqlRequestCache) getFingerprintIndex(ch *ent.Channel) channelFingerprintIndex {
	key := channelFingerprintCacheKey{
		channelID:         ch.ID,
		updatedAtUnixNano: ch.UpdatedAt.UnixNano(),
	}
	c.mu.Lock()
	entry, ok := c.fingerprints[key]
	if !ok {
		entry = &cachedFingerprintIndex{}
		c.fingerprints[key] = entry
	}
	c.mu.Unlock()

	entry.once.Do(func() {
		entry.idx = buildChannelFingerprintIndex(ch)
	})

	return entry.idx
}

func buildChannelFingerprintIndex(ch *ent.Channel) channelFingerprintIndex {
	refs := ch.Credentials.GetAllCredentialRefs()
	supportsNames := ch.Type != channel.TypeAntigravity && ch.Type != channel.TypeGeminiVertex && !ch.Credentials.IsOAuth()
	var nameByKey map[string]string
	if supportsNames && len(ch.Credentials.APIKeyNames) > 0 {
		flatKeys := ch.Credentials.GetFlatAPIKeys()
		if len(flatKeys) > 0 {
			eligibleKeys := make(map[string]struct{}, len(flatKeys))
			for _, flatKey := range flatKeys {
				eligibleKeys[flatKey] = struct{}{}
			}
			nameByKey = make(map[string]string, len(ch.Credentials.APIKeyNames))
			for _, entry := range ch.Credentials.APIKeyNames {
				if entry.Key == "" {
					continue
				}
				if _, eligible := eligibleKeys[entry.Key]; !eligible {
					continue
				}
				// Preserve NameOf last-entry-wins semantics (including blank clearing an earlier name).
				nameByKey[entry.Key] = strings.TrimSpace(entry.Name)
			}
		}
	}

	byFP := make(map[string]fingerprintLabelEntry, len(refs))
	for i, ref := range refs {
		fp := objects.CredentialFingerprint(ref)
		if fp == "" {
			continue
		}
		if _, exists := byFP[fp]; exists {
			continue
		}
		name := ""
		if nameByKey != nil {
			name = nameByKey[ref]
		}
		byFP[fp] = fingerprintLabelEntry{
			name:  name,
			index: i + 1,
		}
	}
	return channelFingerprintIndex{
		refCount: len(refs),
		byFP:     byFP,
	}
}

func resolveChannelAPIKeyLabel(
	ctx context.Context,
	client *ent.Client,
	obj *ent.RequestExecution,
) (*ChannelAPIKeyLabel, error) {
	if obj == nil || obj.ChannelAPIKeyFingerprint == nil || *obj.ChannelAPIKeyFingerprint == "" || obj.ChannelID == 0 {
		return nil, nil
	}

	ch, err := getNilableChannel(ctx, client, obj.ChannelID)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, nil
	}

	var idx channelFingerprintIndex
	if cache := requestCacheFromContext(ctx); cache != nil && ent.TxFromContext(ctx) == nil {
		idx = cache.getFingerprintIndex(ch)
	} else {
		idx = buildChannelFingerprintIndex(ch)
	}

	entry, ok := idx.byFP[*obj.ChannelAPIKeyFingerprint]
	if !ok {
		return &ChannelAPIKeyLabel{Deleted: true}, nil
	}
	if entry.name != "" {
		return &ChannelAPIKeyLabel{
			Name:    lo.ToPtr(entry.name),
			Deleted: false,
		}, nil
	}
	if idx.refCount > 1 {
		return &ChannelAPIKeyLabel{
			Index:   lo.ToPtr(entry.index),
			Deleted: false,
		}, nil
	}
	return &ChannelAPIKeyLabel{Deleted: false}, nil
}
