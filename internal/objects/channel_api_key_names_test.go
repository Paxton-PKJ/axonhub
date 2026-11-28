// 职责: 验证渠道 API 密钥名称规范化、Unicode 长度边界校验、裁剪及 SHA-256 指纹生成工具。
// 关联文件:
//   internal/objects/channel.go
//   internal/pkg/xerrors/graphql.go
// 遵循的 Rules:
//   .agents/rules/go-general.md
// 注意事项:
//   长度上限按 utf8.RuneCountInString 计（64 字符），需同时覆盖 ASCII 与中文多字节字符。

package objects

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/pkg/xerrors"
)

func TestChannelCredentialsNameOf(t *testing.T) {
	var nilCreds *ChannelCredentials
	require.Equal(t, "", nilCreds.NameOf("k1"))

	creds := &ChannelCredentials{
		APIKeyNames: []APIKeyName{
			{Key: "k1", Name: "first"},
			{Key: "k1", Name: "  override-name  "},
			{Key: "k2", Name: "   "},
		},
	}
	require.Equal(t, "", creds.NameOf(""))
	require.Equal(t, "override-name", creds.NameOf("k1"))
	require.Equal(t, "", creds.NameOf("k2"))
	require.Equal(t, "", creds.NameOf("missing"))
}

func TestChannelCredentialsNormalizeAPIKeyNames(t *testing.T) {
	var nilCreds *ChannelCredentials
	require.NoError(t, nilCreds.NormalizeAPIKeyNames([]string{"k1"}))

	t.Run("trims drops blank orphans and keeps last duplicate in order", func(t *testing.T) {
		creds := &ChannelCredentials{
			APIKeyNames: []APIKeyName{
				{Key: "k1", Name: "old-k1"},
				{Key: "orphan", Name: "should-drop"},
				{Key: "k2", Name: "   "},
				{Key: "k3", Name: "  prod-key  "},
				{Key: "k1", Name: "  primary-key "},
				{Key: "", Name: "empty-key"},
			},
		}

		err := creds.NormalizeAPIKeyNames([]string{"k1", "k2", "k3"})
		require.NoError(t, err)
		require.Equal(t, []APIKeyName{
			{Key: "k3", Name: "prod-key"},
			{Key: "k1", Name: "primary-key"},
		}, creds.APIKeyNames)
	})

	t.Run("clears slice to nil when no valid names remain", func(t *testing.T) {
		creds := &ChannelCredentials{
			APIKeyNames: []APIKeyName{
				{Key: "k1", Name: "  "},
				{Key: "deleted", Name: "stale"},
			},
		}

		err := creds.NormalizeAPIKeyNames([]string{"k1"})
		require.NoError(t, err)
		require.Nil(t, creds.APIKeyNames)
	})

	t.Run("enforces unicode 64 char boundary", func(t *testing.T) {
		exactChinese := strings.Repeat("密", MaxAPIKeyNameLength)
		tooLongChinese := strings.Repeat("密", MaxAPIKeyNameLength+1)

		okCreds := &ChannelCredentials{
			APIKeyNames: []APIKeyName{{Key: "k1", Name: " " + exactChinese + " "}},
		}
		require.NoError(t, okCreds.NormalizeAPIKeyNames([]string{"k1"}))
		require.Equal(t, exactChinese, okCreds.APIKeyNames[0].Name)

		badCreds := &ChannelCredentials{
			APIKeyNames: []APIKeyName{{Key: "k1", Name: tooLongChinese}},
		}
		err := badCreds.NormalizeAPIKeyNames([]string{"k1"})
		require.Error(t, err)
		var coded *xerrors.CodedError
		require.True(t, errors.As(err, &coded))
		require.Equal(t, xerrors.ErrCodeValidationFailed, coded.Code)
	})
}

func TestChannelCredentialsPruneAPIKeyNames(t *testing.T) {
	tooLongLegacy := strings.Repeat("a", MaxAPIKeyNameLength+10)
	creds := &ChannelCredentials{
		APIKeyNames: []APIKeyName{
			{Key: "k1", Name: tooLongLegacy},
			{Key: "k2", Name: "removed"},
		},
	}

	creds.PruneAPIKeyNames([]string{"k1"})
	require.Equal(t, []APIKeyName{{Key: "k1", Name: tooLongLegacy}}, creds.APIKeyNames)
}

func TestCredentialFingerprint(t *testing.T) {
	require.Equal(t, "", CredentialFingerprint(""))

	fp1 := CredentialFingerprint("sk-alpha-1234")
	fp2 := CredentialFingerprint("sk-bravo-1234")
	sum := sha256.Sum256([]byte("sk-alpha-1234"))
	require.Equal(t, hex.EncodeToString(sum[:]), fp1)
	require.Len(t, fp1, 64)
	require.NotEqual(t, fp1, fp2)
	require.Equal(t, fp1, CredentialFingerprint("sk-alpha-1234"))
}
