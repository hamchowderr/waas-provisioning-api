<?php
/**
 * AnyPress theme setup.
 *
 * Presentation only: pattern categories and a few block styles. Everything a store does
 * (bindings, abilities, site tools) lives in the WaaS Client plugin.
 *
 * @package AnyPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Pattern categories. Core categories are used where they fit; these group the
 * AnyPress sections so the inserter and the site tools can list them.
 */
function anypress_register_pattern_categories() {
	$categories = array(
		'anypress-heroes'   => array( __( 'Heroes', 'anypress' ), __( 'Opening sections that say what the business does and give one main action.', 'anypress' ) ),
		'anypress-proof'    => array( __( 'Proof', 'anypress' ), __( 'Reviews, results, logos and credentials that make visitors trust the business.', 'anypress' ) ),
		'anypress-details'  => array( __( 'Business details', 'anypress' ), __( 'Opening hours, location, areas served and contact details.', 'anypress' ) ),
		// The same category the store template's starter pages use, so the site tools find both.
		'anypress/pages'    => array( __( 'Starter pages', 'anypress' ), __( 'Whole pages to start from, for this kind of website.', 'anypress' ) ),
		// Kits: sections designed together for one kind of business, each with its own style variation.
		'anypress/kit-home-services' => array( __( 'Kit: Home services (Ridge)', 'anypress' ), __( 'Sections for trades and home services. They look as designed with the Ridge style.', 'anypress' ) ),
		'anypress/kit-food'          => array( __( 'Kit: Food and drink (Hearth)', 'anypress' ), __( 'Sections for cafés, bakeries and restaurants. They look as designed with the Hearth style.', 'anypress' ) ),
		'anypress/kit-wellness'      => array( __( 'Kit: Wellness (Still)', 'anypress' ), __( 'Sections for spas, therapists and studios. They look as designed with the Still style.', 'anypress' ) ),
		'anypress/kit-professional'  => array( __( 'Kit: Professional services (Ledger)', 'anypress' ), __( 'Sections for accountants, lawyers, consultants and agencies. They look as designed with the Ledger style.', 'anypress' ) ),
	);
	foreach ( $categories as $slug => $category ) {
		if ( WP_Block_Pattern_Categories_Registry::get_instance()->is_registered( $slug ) ) {
			continue;
		}
		register_block_pattern_category(
			$slug,
			array(
				'label'       => $category[0],
				'description' => $category[1],
			)
		);
	}
}
add_action( 'init', 'anypress_register_pattern_categories' );

/**
 * Block styles kept from the stores' previous theme, so pages built with it still render.
 */
function anypress_register_block_styles() {
	register_block_style(
		'core/cover',
		array(
			'name'         => 'blur-image-less',
			'label'        => __( 'Soft blur', 'anypress' ),
			'inline_style' => '.wp-block-cover.is-style-blur-image-less img.wp-block-cover__image-background{filter:blur(6px);transform:scale(1.04)}',
		)
	);

	// A list without bullets, for lists set large (towns served, opening times).
	register_block_style(
		'core/list',
		array(
			'name'         => 'no-bullets',
			'label'        => __( 'No bullets', 'anypress' ),
			'inline_style' => '.wp-block-list.is-style-no-bullets{list-style:none;padding-inline-start:0}',
		)
	);

	// A menu line: the first block (the dish), a dotted line, then the last block (the price).
	register_block_style(
		'core/group',
		array(
			'name'         => 'menu-leader',
			'label'        => __( 'Menu line', 'anypress' ),
			'inline_style' => '.wp-block-group.is-style-menu-leader{align-items:baseline}.wp-block-group.is-style-menu-leader>*{margin-block:0}.wp-block-group.is-style-menu-leader>:first-child{display:flex;flex:1 1 auto;align-items:baseline;gap:.4em}.wp-block-group.is-style-menu-leader>:first-child::after{content:"";flex:1 1 auto;min-width:1.5em;border-bottom:.12em dotted currentColor;opacity:.5}',
		)
	);
}
add_action( 'init', 'anypress_register_block_styles' );

/**
 * Stores show only this theme's patterns: no remote Pattern Directory calls.
 */
add_filter( 'should_load_remote_block_patterns', '__return_false' );

/**
 * Core's generic patterns are removed so the inserter and the site tools only offer
 * sections built from this theme's tokens.
 */
function anypress_setup() {
	remove_theme_support( 'core-block-patterns' );
}
add_action( 'after_setup_theme', 'anypress_setup' );

/**
 * Sections run edge to edge: no page-level gap above the footer, so the last section meets it.
 */
function anypress_enqueue_styles() {
	wp_register_style( 'anypress', false, array(), wp_get_theme()->get( 'Version' ) );
	wp_enqueue_style( 'anypress' );
	// A photo alone in a column fills the column's height, so it meets the panel beside it.
	wp_add_inline_style( 'anypress', '.wp-site-blocks>footer{margin-block-start:0}.wp-block-column>.wp-block-cover:only-child{height:100%}' );
}
add_action( 'wp_enqueue_scripts', 'anypress_enqueue_styles' );
