using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase4ReviewSecurityAndRecovery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "CapabilityEnvelopeJson",
                table: "Tasks",
                type: "TEXT",
                maxLength: 100000,
                nullable: false,
                defaultValue: "{}");

            migrationBuilder.AddColumn<long>(
                name: "CodexTurnStartRequestedAtMs",
                table: "TaskExecutions",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "CapabilityEnvelopeJson",
                table: "Tasks");

            migrationBuilder.DropColumn(
                name: "CodexTurnStartRequestedAtMs",
                table: "TaskExecutions");
        }
    }
}
