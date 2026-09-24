package main

import (
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
)

// Injected by -ldflags; docs/operations.md asks operators to record the build revision.
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	log.Printf("fangji backend %s (commit %s, built %s)", version, commit, buildDate)
	app := pocketbase.New()

	var hooksDir string
	app.RootCmd.PersistentFlags().StringVar(&hooksDir, "hooksDir", "", "the directory with the JS app hooks")

	var hooksWatch bool
	app.RootCmd.PersistentFlags().BoolVar(&hooksWatch, "hooksWatch", true, "auto restart on JS hook changes")

	var hooksPool int
	app.RootCmd.PersistentFlags().IntVar(&hooksPool, "hooksPool", 25, "the JS hook runtime pool size")

	var migrationsDir string
	app.RootCmd.PersistentFlags().StringVar(&migrationsDir, "migrationsDir", "", "the directory with migrations")

	var automigrate bool
	app.RootCmd.PersistentFlags().BoolVar(&automigrate, "automigrate", true, "enable automatic migrations")

	app.RootCmd.ParseFlags(os.Args[1:])

	jsvm.MustRegister(app, jsvm.Config{
		MigrationsDir: migrationsDir,
		HooksDir:      hooksDir,
		HooksWatch:    hooksWatch,
		HooksPoolSize: hooksPool,
	})
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		TemplateLang: migratecmd.TemplateLangJS,
		Automigrate:  automigrate,
		Dir:          migrationsDir,
	})
	registerTrustedClientIP(app)
	registerProfile(app)
	registerJoinAttemptCleanup(app)

	if err := registerKeyboardPresets(app); err != nil {
		log.Fatal(err)
	}

	importer := newImportService(app)
	importer.register()
	importer.registerOCR()
	importer.registerPDFPreview()
	importer.registerPagination()

	identityProviders := make([]externalIdentityProvider, 0, 1)
	if hinghwaBaseURL := os.Getenv("HINGHWA_IDENTITY_BASE_URL"); hinghwaBaseURL != "" {
		hinghwaProvider, err := newHinghwaIdentityProvider(hinghwaBaseURL)
		if err != nil {
			log.Fatal(err)
		}
		identityProviders = append(identityProviders, hinghwaProvider)
	}
	externalIdentities := newExternalIdentityService(app, identityProviders...)
	externalIdentities.register()

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
