//go:build ignore

package main

import (
	"fmt"
	"log"
	"maps"
	"path/filepath"

	"entgo.io/contrib/entgql"
	"entgo.io/ent/entc"
	"entgo.io/ent/entc/gen"
	"entgo.io/ent/schema/field"
	"github.com/looplj/axonhub/internal/pkg/xfile"
)

type collectedForGroup struct {
	GQLName string
	Fields  []*gen.Field
}

func decodeEntGQLAnnotation(f *gen.Field) (*entgql.Annotation, error) {
	ant := &entgql.Annotation{}
	if f == nil || f.Annotations == nil {
		return ant, nil
	}
	if raw := f.Annotations[ant.Name()]; raw != nil {
		if err := ant.Decode(raw); err != nil {
			return nil, err
		}
	}
	return ant, nil
}

// fieldCaseGroups builds the exact GraphQL field switch cases for CollectFields:
// 1. Each exposed, non-sensitive field owns its own GraphQL field name / Mapping cases
//    selecting only itself (without absorbing CollectedFor columns meant for sibling fields).
// 2. Every field declaring entgql.CollectedFor adds its SQL column solely to each named
//    GraphQL field case (including Sensitive/SkipType fields and virtual resolvers).
func fieldCaseGroups(allFields, exposedFields []*gen.Field) ([]collectedForGroup, error) {
	fieldMappingFn, ok := entgql.TemplateFuncs["fieldMapping"].(func(*gen.Field) ([]string, error))
	if !ok {
		return nil, fmt.Errorf("entgql fieldMapping template function unavailable")
	}

	var order []string
	groups := make(map[string][]*gen.Field)
	seenField := make(map[string]map[string]struct{})
	addField := func(gqlName string, f *gen.Field) {
		if gqlName == "" || f == nil {
			return
		}
		if _, ok := groups[gqlName]; !ok {
			order = append(order, gqlName)
			seenField[gqlName] = make(map[string]struct{})
		}
		if _, dup := seenField[gqlName][f.Constant()]; !dup {
			seenField[gqlName][f.Constant()] = struct{}{}
			groups[gqlName] = append(groups[gqlName], f)
		}
	}

	for _, f := range exposedFields {
		names, err := fieldMappingFn(f)
		if err != nil {
			return nil, err
		}
		for _, name := range names {
			addField(name, f)
		}
	}

	for _, f := range allFields {
		ant, err := decodeEntGQLAnnotation(f)
		if err != nil {
			return nil, err
		}
		for _, gqlName := range ant.CollectedFor {
			addField(gqlName, f)
		}
	}

	res := make([]collectedForGroup, 0, len(order))
	for _, name := range order {
		res = append(res, collectedForGroup{
			GQLName: name,
			Fields:  groups[name],
		})
	}
	return res, nil
}

func main() {
	templateFuncs := maps.Clone(entgql.TemplateFuncs)
	templateFuncs["fieldCaseGroups"] = fieldCaseGroups

	customPaginationTemplate, err := gen.NewTemplate(entgql.PaginationTemplate.Name()).
		Funcs(templateFuncs).
		ParseFiles(filepath.Join(xfile.CurDir(), "template", "pagination.tmpl"))
	if err != nil {
		log.Fatalf("creating custom entgql pagination template: %v", err)
	}

	customCollectionTemplate, err := gen.NewTemplate(entgql.CollectionTemplate.Name()).
		Funcs(templateFuncs).
		ParseFiles(filepath.Join(xfile.CurDir(), "template", "collection.tmpl"))
	if err != nil {
		log.Fatalf("creating custom entgql collection template: %v", err)
	}

	templates := make([]*gen.Template, len(entgql.AllTemplates))
	copy(templates, entgql.AllTemplates)
	for i, tmpl := range templates {
		switch tmpl.Name() {
		case entgql.PaginationTemplate.Name():
			templates[i] = customPaginationTemplate
		case entgql.CollectionTemplate.Name():
			templates[i] = customCollectionTemplate
		}
	}

	ex, err := entgql.NewExtension(
		entgql.WithTemplates(templates...),
		// entgql.WithConfigPath("../graph/gqlgen.yml"),
		// entgql.WithConfigPath("./graph/gqlgen.yml"),
		entgql.WithConfigPath("gqlgen.yml"),
		entgql.WithSchemaGenerator(),
		// entgql.WithSchemaPath("../graph/ent.graphql"),
		// entgql.WithSchemaPath("./graph/ent.graphql"),
		entgql.WithSchemaPath("ent.graphql"),
		entgql.WithWhereInputs(true),
		entgql.WithNodeDescriptor(true),
		entgql.WithRelaySpec(true),
	)
	if err != nil {
		log.Fatalf("creating entgql extension: %v", err)
	}
	opts := []entc.Option{
		entc.FeatureNames("intercept", "schema/snapshot", "sql/upsert", "sql/modifier", "entql", "privacy"),
		entc.Extensions(ex),
	}
	// rt := reflect.TypeOf(objects.GUID{})
	if err := entc.Generate(filepath.Join(xfile.CurDir(), "schema"), &gen.Config{
		IDType: field.Int("id").Annotations(
			entgql.Skip(entgql.SkipWhereInput),
		).Descriptor().Info,
		// IDType: &field.TypeInfo{
		// 	Type:    field.TypeUUID,
		// 	Ident:   rt.String(),
		// 	PkgPath: rt.PkgPath(),
		// },
	}, opts...); err != nil {
		log.Fatalf("running ent codegen: %v", err)
	}
}
